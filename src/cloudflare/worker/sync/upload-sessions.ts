import type { EncryptionServerState } from '../../../encryption/server-state';
import { EncryptionStateError } from '../encryption/state';
import { readLimitedRequestBody } from '../http/body-reader';
import { corsResponse } from '../http/cors';
import { parseJsonObject, sanitizePath } from '../http/request-validation';
import { isMarkdownPath } from '../../../protocol/note-paths';
import { MAX_FILE_SIZE_BYTES, UPLOAD_PART_BYTES } from '../../../protocol/sync-limits';
import { createManagedObjectKey } from '../../../protocol/storage-keys';
import { UPLOAD_OPERATION_HEADER } from '../../../protocol/http-headers';
import { isSha256Hex } from '../../../platform/validation';
import { FileNamespaceConflictError } from './file-namespace';
import { formatMetadataCommitFailure, formatMutationError, parseExpectedFileHash, type ExpectedFileHash } from './storage';
import { trackUploadLease } from './staging/upload-leases';
import type { UploadCommitters } from './staging/upload-committers';
import { beginUploadOperation, type UploadOperation } from './upload-operations';

/** In-progress chunked uploads, one R2 JSON object per upload operation. */
export const UPLOAD_SESSION_PREFIX = '__crate__/upload-sessions/';
/** Matches the upload lease, after which lease cleanup may reclaim the object key. */
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface UploadFile { path: string; hash: string; size: number; contentType: string; expectedHash: ExpectedFileHash }
interface UploadSession extends UploadFile {
	version: 1;
	requestHash: string;
	storageKey: string;
	uploadId: string;
	leaseId: string;
	createdAt: number;
}

const sessionKey = (operationId: string) => `${UPLOAD_SESSION_PREFIX}${operationId}.json`;
const partCount = (size: number) => Math.ceil(size / UPLOAD_PART_BYTES);
const partSize = (size: number, part: number) => part < partCount(size) ? UPLOAD_PART_BYTES : size - (partCount(size) - 1) * UPLOAD_PART_BYTES;

async function readSession(bucket: R2Bucket, operationId: string): Promise<UploadSession | null> {
	const object = await bucket.get(sessionKey(operationId));
	return object ? JSON.parse(await object.text()) as UploadSession : null;
}

function parseFile(value: Record<string, unknown>, maxFileBytes: number): UploadFile | Response {
	const path = typeof value.path === 'string' ? sanitizePath(value.path) : null;
	const expectedHash = parseExpectedFileHash(value.expectedHash);
	if (!path || !isSha256Hex(value.hash) || typeof value.contentType !== 'string' || value.contentType.length > 256 || expectedHash === undefined
		|| typeof value.size !== 'number' || !Number.isSafeInteger(value.size)) {
		return corsResponse({ success: false, error: 'Invalid upload session', code: 'validation' }, 400);
	}
	// Smaller files and Markdown, whose reminders and Reading cards the server reads, use one request.
	if (value.size <= MAX_FILE_SIZE_BYTES || isMarkdownPath(path)) return corsResponse({ success: false, path, error: 'Upload this file in one request', code: 'validation' }, 400);
	if (value.size > maxFileBytes) return corsResponse({ success: false, path, error: 'File exceeds the server file limit', code: 'file_too_large' }, 413);
	return { path, hash: value.hash, size: value.size, contentType: value.contentType, expectedHash };
}

/** Begins or resumes a chunked upload, receives one part, or completes it. Plaintext only:
 * route policy refuses these paths in an encrypted vault. */
export async function handleUploadSession(request: Request, bucket: R2Bucket, db: D1Database, committers: UploadCommitters, maxFileBytes: number,
	encryption: EncryptionServerState | null, resetGeneration: string | null): Promise<Response> {
	if (encryption) return new EncryptionStateError('Encrypted vaults upload each file in one request', 428).toResponse();
	const url = new URL(request.url);
	if (request.method === 'PUT') return receivePart(request, bucket, url);
	const action = url.searchParams.get('action');
	if (action === 'begin' || action === 'complete') {
		const parsed = await parseJsonObject(request);
		if (!parsed.ok) return parsed.response;
		const file = parseFile(parsed.value, maxFileBytes);
		if (file instanceof Response) return file;
		// A stored receipt answers a retry after a lost response, for either step.
		const operation = await beginUploadOperation(db, request.headers.get(UPLOAD_OPERATION_HEADER), file);
		if (operation instanceof Response) return operation;
		return action === 'begin'
			? beginSession(bucket, db, file, operation, resetGeneration)
			: completeSession(bucket, db, committers, file, operation, parsed.value.parts, resetGeneration);
	}
	return corsResponse({ error: 'Unknown upload session action' }, 400);
}

async function beginSession(bucket: R2Bucket, db: D1Database, file: UploadFile, operation: UploadOperation, resetGeneration: string | null): Promise<Response> {
	const existing = await readSession(bucket, operation.id);
	if (existing) {
		if (existing.requestHash !== operation.requestHash) return corsResponse({ success: false, path: file.path, status: 409, code: 'operation_mismatch', error: 'An upload operation ID cannot be reused for different bytes or preconditions.' }, 409);
		return corsResponse({ session: { partBytes: UPLOAD_PART_BYTES } });
	}
	const storageKey = createManagedObjectKey(file.hash);
	const { id: leaseId } = await trackUploadLease(db, [{ storageKey, path: file.path }], { encrypted: false, expectedEncryption: null, resetGeneration });
	const upload = await bucket.createMultipartUpload(storageKey, { httpMetadata: { contentType: file.contentType }, customMetadata: { hash: file.hash } });
	const session: UploadSession = { version: 1, ...file, requestHash: operation.requestHash, storageKey, uploadId: upload.uploadId, leaseId, createdAt: Date.now() };
	await bucket.put(sessionKey(operation.id), JSON.stringify(session), { httpMetadata: { contentType: 'application/json' } });
	return corsResponse({ session: { partBytes: UPLOAD_PART_BYTES } });
}

async function receivePart(request: Request, bucket: R2Bucket, url: URL): Promise<Response> {
	const operationId = request.headers.get(UPLOAD_OPERATION_HEADER);
	const part = Number(url.searchParams.get('part'));
	const session = operationId ? await readSession(bucket, operationId) : null;
	if (!session) return corsResponse({ success: false, error: 'This upload session ended. Start it again.', code: 'upload_session_missing' }, 404);
	if (!Number.isInteger(part) || part < 1 || part > partCount(session.size)) return corsResponse({ success: false, path: session.path, error: 'Invalid upload part', code: 'validation' }, 400);
	const expected = partSize(session.size, part);
	const body = await readLimitedRequestBody(request, expected, 'Upload part exceeds its size');
	if (!body.ok) return body.response;
	if (body.bytes.byteLength !== expected) return corsResponse({ success: false, path: session.path, error: 'Upload part has the wrong size', code: 'validation' }, 400);
	const uploaded = await bucket.resumeMultipartUpload(session.storageKey, session.uploadId).uploadPart(part, body.bytes);
	return corsResponse({ etag: uploaded.etag });
}

function parseParts(value: unknown, size: number): R2UploadedPart[] | null {
	if (!Array.isArray(value) || value.length !== partCount(size)) return null;
	const parts = value.map((item: unknown, index): R2UploadedPart | null => {
		const part = item as Partial<R2UploadedPart> | null;
		return part && part.partNumber === index + 1 && typeof part.etag === 'string' && part.etag.length > 0 && part.etag.length <= 256
			? { partNumber: part.partNumber, etag: part.etag } : null;
	});
	return parts.every((part): part is R2UploadedPart => part !== null) ? parts : null;
}

/** SHA-256 of a stored object without holding it in memory. */
async function storedObjectSha256(bucket: R2Bucket, key: string): Promise<{ hash: string; size: number } | null> {
	const object = await bucket.get(key);
	if (!object?.body) return null;
	const digest = new crypto.DigestStream('SHA-256');
	await object.body.pipeTo(digest);
	return { hash: [...new Uint8Array(await digest.digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), size: object.size };
}

async function completeSession(bucket: R2Bucket, db: D1Database, committers: UploadCommitters, file: UploadFile, operation: UploadOperation,
	rawParts: unknown, resetGeneration: string | null): Promise<Response> {
	const session = await readSession(bucket, operation.id);
	if (!session) return corsResponse({ success: false, path: file.path, error: 'This upload session ended. Start it again.', code: 'upload_session_missing' }, 404);
	if (session.requestHash !== operation.requestHash) return corsResponse({ success: false, path: file.path, status: 409, code: 'operation_mismatch', error: 'An upload operation ID cannot be reused for different bytes or preconditions.' }, 409);
	const parts = parseParts(rawParts, session.size);
	if (!parts) return corsResponse({ success: false, path: file.path, error: 'Every upload part is required, in order', code: 'validation' }, 400);
	try {
		await bucket.resumeMultipartUpload(session.storageKey, session.uploadId).complete(parts);
	} catch (error) {
		// A completion whose response was lost left the object in place; anything else is refused.
		if ((await bucket.head(session.storageKey))?.size !== session.size) {
			return corsResponse({ success: false, path: file.path, error: `Upload parts could not be combined: ${formatMutationError(error)}`, code: 'validation' }, 400);
		}
	}
	const stored = await storedObjectSha256(bucket, session.storageKey);
	if (!stored || stored.hash !== session.hash || stored.size !== session.size) {
		await bucket.delete([session.storageKey, sessionKey(operation.id)]);
		return corsResponse({ success: false, path: file.path, error: 'Uploaded parts do not match the file hash', code: 'validation' }, 400);
	}
	try {
		// Plaintext attachments carry nothing the server parses at publication.
		const commit = await committers.commitUpload(bucket, db, {
			path: session.path, hash: session.hash, size: session.size, objectKey: session.storageKey, leaseId: session.leaseId,
			content: new ArrayBuffer(0), expectedHash: session.expectedHash, operation, encryptionState: null, resetGeneration,
		});
		await bucket.delete(sessionKey(operation.id));
		if (!commit.committed) {
			if (commit.failure) return corsResponse(commit.failure, commit.failure.status ?? 409);
			return corsResponse({ success: false, path: session.path, error: 'Remote file changed since it was read', code: 'version_conflict', currentHash: commit.currentHash }, 409);
		}
		return corsResponse({ success: true, path: session.path, hash: session.hash, revision: commit.revision });
	} catch (error: unknown) {
		if (error instanceof EncryptionStateError) return error.toResponse();
		if (error instanceof FileNamespaceConflictError) return error.toResponse();
		// The transaction may have committed before its response was lost; the receipt answers a retry.
		return corsResponse({ success: false, path: session.path, error: formatMetadataCommitFailure('Upload', formatMutationError(error)) }, 503);
	}
}

/** Copies a stored object part by part, without holding it in memory, and returns the copy's
 * SHA-256. A failure aborts the copy. */
export async function copyObjectInParts(bucket: R2Bucket, sourceKey: string, targetKey: string, size: number,
	options: R2MultipartOptions): Promise<string> {
	const upload = await bucket.createMultipartUpload(targetKey, options);
	const digest = new crypto.DigestStream('SHA-256');
	const writer = digest.getWriter();
	try {
		const parts: R2UploadedPart[] = [];
		for (let part = 1; part <= partCount(size); part++) {
			const source = await bucket.get(sourceKey, { range: { offset: (part - 1) * UPLOAD_PART_BYTES, length: partSize(size, part) } });
			if (!source) throw new Error('Stored file content is unavailable');
			const bytes = new Uint8Array(await source.arrayBuffer());
			await writer.write(bytes);
			parts.push(await upload.uploadPart(part, bytes));
		}
		await writer.close();
		await upload.complete(parts);
	} catch (error) {
		await upload.abort().catch(() => {});
		throw error;
	}
	return [...new Uint8Array(await digest.digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Aborts chunked uploads older than their lease, so R2 keeps no unfinished parts. Returns
 * whether a full page held expired sessions, so more may remain. */
export async function abortExpiredUploadSessions(bucket: R2Bucket, now = Date.now(), limit = 50): Promise<boolean> {
	const listed = await bucket.list({ prefix: UPLOAD_SESSION_PREFIX, limit });
	let removed = 0;
	for (const object of listed.objects) {
		if (now - object.uploaded.getTime() < UPLOAD_SESSION_TTL_MS) continue;
		removed++;
		const session = await bucket.get(object.key);
		const value = session ? JSON.parse(await session.text()) as UploadSession : null;
		if (value) await bucket.resumeMultipartUpload(value.storageKey, value.uploadId).abort().catch(() => {});
		await bucket.delete(object.key);
	}
	return listed.truncated && removed > 0;
}
