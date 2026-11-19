import type { BatchUploadResponse } from '@/protocol/sync-types';
import { BATCH_UPLOAD_MAX_BYTES } from '@/protocol/sync-limits';
import { fileTransportLimit } from '@/encryption/file-format';
import { INITIAL_IMPORT_MAX_FILES } from '@/protocol/initial-import';
import { base64ToArrayBuffer } from '@/platform/base64';
import { corsResponse } from '../../http/cors';
import { parseJsonObject, sanitizePath, UPLOAD_BATCH_JSON_BODY_BYTES } from '../../http/request-validation';
import { loadStoredFileRows, parseExpectedFileHash } from '../storage';
import { finishUploadLeases, trackUploadLease } from '../staging/upload-leases';
import { queueReplacedUploadCleanup, uploadMutation } from '../mutations';
import { descriptorColumn, EncryptionStateError, hasEncryptionAuthority, parseEncryptionState,
	prepareEncryptedFileCommit, validateUploadEncryption } from '../../encryption/state';
import type { EncryptionServerState } from '@/encryption/server-state';
import { readingIndexStatements } from '../../reading/library-index';
import { readLimitedRequestBody } from '../../http/body-reader';
import { isSha256Hex } from '@/platform/validation';
import { createManagedObjectKey } from '@/protocol/storage-keys';
import { FILE_HASH_HEADER, EXPECTED_HASH_HEADER, INITIAL_IMPORT_HEADER } from '@/protocol/http-headers';
import { sha256Hex } from '@/platform/sha256';
import { mapBounded } from '@/platform/map-bounded';

const R2_IMPORT_WRITE_CONCURRENCY = 4;

interface ImportFile {
	path: string; hash: string; size: number; content: ArrayBuffer;
	contentType: string; expectedHash: string | null;
}

/** The open import with the server state its publication is checked against. */
interface ImportScope { token: string; encryption: EncryptionServerState | null; resetGeneration: string | null }

/** Runs in a transfer object: the public Worker authenticated the request. An encrypted
 * vault's import is checked against the state read here, in the same transactions that
 * lease and publish its files, so a reset in between fences every later batch. */
export async function uploadInitialFiles(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
	const token = request.headers.get(INITIAL_IMPORT_HEADER);
	const current = await db.prepare(`SELECT import_token AS token, import_state AS state, encryption, reset_generation
    FROM server_state WHERE id = 1`).first<{ token: string | null; state: string | null; encryption: string | null; reset_generation: string | null }>();
	if (!current?.token || current.token !== token || current.state !== 'importing') return corsResponse({ error: 'Initial import is closed or unavailable' }, 409);
	const encryption = parseEncryptionState(current.encryption);
	if (encryption && (encryption.mode !== 'active' || !hasEncryptionAuthority(request, encryption))) {
		return new EncryptionStateError('Unlock this vault with its current encryption keys before syncing', 428).toResponse();
	}
	const input: Array<Record<string, unknown>> = [];
	if (request.method === 'PUT') {
		// Large attachments use a binary request, without base64 copies in memory.
		// Ciphertext of a file at the plaintext limit is larger than that limit.
		const body = await readLimitedRequestBody(request, fileTransportLimit(request.headers.get('Content-Type') ?? undefined), 'File exceeds 25MB limit');
		if (!body.ok) return body.response;
		input.push({ path: new URL(request.url).searchParams.get('path'),
			hash: request.headers.get(FILE_HASH_HEADER), content: body.bytes.buffer,
			contentType: request.headers.get('Content-Type'), expectedHash: parseExpectedFileHash(request.headers.get(EXPECTED_HASH_HEADER)) });
	} else {
		const parsed = await parseJsonObject(request, UPLOAD_BATCH_JSON_BODY_BYTES);
		if (!parsed.ok) return parsed.response;
		if (!Array.isArray(parsed.value.files) || !parsed.value.files.length || parsed.value.files.length > INITIAL_IMPORT_MAX_FILES) {
			return corsResponse({ error: 'Invalid import batch' }, 400);
		}
		for (const value of parsed.value.files as unknown[]) {
			if (!value || typeof value !== 'object') return corsResponse({ error: 'Invalid import file' }, 400);
			input.push(value as Record<string, unknown>);
		}
	}
	const files: ImportFile[] = [];
	const paths = new Set<string>();
	let total = 0;
	for (const value of input) {
		const path = typeof value.path === 'string' ? sanitizePath(value.path) : null;
		const expectedHash = parseExpectedFileHash(value.expectedHash);
		if (!path || paths.has(path) || expectedHash === undefined || !isSha256Hex(value.hash)) {
			return corsResponse({ error: 'Invalid import metadata' }, 400);
		}
		paths.add(path);
		let content: ArrayBuffer;
		try {
			if (value.content instanceof ArrayBuffer) content = value.content;
			else content = base64ToArrayBuffer(value.content as string);
		} catch { return corsResponse({ error: 'Invalid import content' }, 400); }
		total += content.byteLength;
		const contentType = typeof value.contentType === 'string' ? value.contentType : 'application/octet-stream';
		if (content.byteLength > fileTransportLimit(contentType) || request.method !== 'PUT' && total > BATCH_UPLOAD_MAX_BYTES) return corsResponse({ error: 'Import payload too large' }, 413);
		if (await sha256Hex(content) !== value.hash) return corsResponse({ error: 'Import content hash mismatch' }, 400);
		files.push({ path, hash: value.hash, size: content.byteLength, content, contentType, expectedHash });
	}
	try {
		await validateUploadEncryption(db, files, encryption);
		return await commitImportFiles({ token, encryption, resetGeneration: current.reset_generation }, files, bucket, db);
	} catch (error) {
		if (error instanceof EncryptionStateError) return error.toResponse();
		throw error;
	}
}

async function commitImportFiles({ token, encryption, resetGeneration }: ImportScope, files: ImportFile[], bucket: R2Bucket, db: D1Database): Promise<Response> {
	const previous = await loadStoredFileRows(db, files.map(file => file.path));
	const results: BatchUploadResponse['results'] = [];
	const pending = files.filter(file => {
		const prior = previous.get(file.path);
		if (prior?.hash !== file.hash || prior.size !== file.size) return true;
		results.push({ path: file.path, success: true, hash: file.hash, revision: prior.storageKey });
		return false;
	}).map(file => ({ ...file, objectKey: createManagedObjectKey(file.hash) }));
	if (!pending.length) return corsResponse({ success: true, results });
	const { id: leaseId } = await trackUploadLease(db, pending.map(file => ({ storageKey: file.objectKey, path: file.path })),
		{ encrypted: Boolean(encryption), expectedEncryption: encryption, resetGeneration });
	// Every decoded body is already in memory, so a rolling pool adds no memory or
	// CPU; it stays below the connection limit, as the fixed groups of three did.
	const stored = await mapBounded(pending, R2_IMPORT_WRITE_CONCURRENCY, async file => {
		try {
			await bucket.put(file.objectKey, file.content, { httpMetadata: { contentType: file.contentType }, customMetadata: { hash: file.hash } });
			return true;
		} catch {
			results.push({ path: file.path, success: false, code: 'storage', status: 503, error: 'Upload interrupted. Sync again to resume.' });
			return false;
		}
	});
	const staged = pending.filter((_file, index) => stored[index]);
	if (staged.length) {
		const uploads = await Promise.all(staged.map(async file => ({
			path: file.path, hash: file.hash, size: file.size, objectKey: file.objectKey,
			expectedHash: file.expectedHash, leaseId, importToken: token, encryptionState: encryption, resetGeneration,
			descriptor: descriptorColumn((await prepareEncryptedFileCommit(db, file.path, file.content, encryption)).descriptor),
		})));
		await db.batch([
			// Read the replaced objects from the live rows before the updates change them.
			...uploads.flatMap(upload => queueReplacedUploadCleanup(db, upload)),
			...uploads.map(upload => uploadMutation(db, upload)),
			...finishUploadLeases(db, uploads),
			db.prepare("UPDATE server_state SET import_generation = import_generation + 1 WHERE id = 1 AND import_token = ? AND import_state = 'importing'").bind(token),
			...await readingIndexStatements(db, staged.map(file => ({ path: file.path, storageKey: file.objectKey, hash: file.hash, size: file.size, content: file.content })),
				{ encrypted: Boolean(encryption) }),
		]);
		const committed = await loadStoredFileRows(db, staged.map(file => file.path));
		for (const file of staged) {
			const row = committed.get(file.path);
			results.push(row?.hash === file.hash && row.size === file.size
				? { path: file.path, success: true, hash: file.hash, revision: row.storageKey }
				: { path: file.path, success: false, code: 'version_conflict', status: 409, error: 'Import file changed. Sync again to compare and resume.' });
		}
	}
	return corsResponse({ success: results.every(result => result.success), results });
}
