import { trackStagedUpload } from './staged-uploads';
import { sha256HexBytes } from './auth';
import { beginUploadOperation } from './upload-operations';
import { isSyncRevision } from '@/protocol/sync-validation';
import { corsResponse } from './cors';
import { commitStagedFile } from './sync-mutations';
import { FileNamespaceConflictError } from './file-namespace';
import {
	createManagedObjectKey,
	MAX_FILE_BYTES,
	getStoredFileRow,
	storedObjectMatchesMetadata,
} from './sync-storage';
import { parseExpectedFileHash } from './sync-storage';
import { parseJsonObject, parseOptionalString, sanitizePath } from './utils';
export { handleListFileVersions } from './file-version-list';

interface FileVersionRow {
	storage_key: string;
	path: string;
	hash: string;
	size: number;
	reason: 'replaced' | 'deleted';
	created_at: string;
	expires_at: number;
}

export async function handleRestoreFileVersion(
	request: Request,
	bucket: R2Bucket,
	db: D1Database,
): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;
	const storageKey = parseOptionalString(parsedBody.value.storageKey, 1024);
	const expectedHash = parseExpectedFileHash(parsedBody.value.expectedHash);
	const path = sanitizePath(typeof parsedBody.value.path === 'string' ? parsedBody.value.path : '');
	const rawRevision = parsedBody.value.expectedRevision;
	const expectedRevision = rawRevision === null ? null : isSyncRevision(rawRevision) ? rawRevision : undefined;
	if (!parsedBody.value.operationId) {
		return corsResponse({ error: 'Update Crate before restoring a file. A durable restore operation is required.', code: 'protocol_incompatible' }, 428);
	}
	if (!isSyncRevision(storageKey) || !path || expectedHash === undefined
		|| expectedRevision === undefined || (expectedHash === null ? expectedRevision !== null : expectedRevision === null)) {
		return corsResponse({ error: 'A retained version, path and current file precondition are required' }, 400);
	}
	// Resolve receipts before reading retained bytes: the original version may
	// expire after commitment, and later edits/deletes must never be replayed over.
	const operation = await beginUploadOperation(db, parsedBody.value.operationId,
		{ kind: 'restore', path, storageKey, expectedHash, expectedRevision });
	if (operation instanceof Response) return operation;

	const version = await db.prepare(`SELECT storage_key, path, hash, size, reason, created_at, expires_at
		FROM file_versions WHERE storage_key = ? AND expires_at > ?`).bind(storageKey, Date.now()).first<FileVersionRow>();
	if (!version) return corsResponse({ error: 'File version not found or expired' }, 404);
	if (version.path !== path) return corsResponse({ error: 'Retained version does not belong to the requested path' }, 409);

	const object = await bucket.get(version.storage_key);
	if (!object || object.size > MAX_FILE_BYTES || !storedObjectMatchesMetadata(object, {
		hash: version.hash,
		size: version.size,
		storageKey: version.storage_key,
	})) {
		return corsResponse({ error: 'Stored file version content is unavailable' }, 503);
	}
	const content = await object.arrayBuffer();
	if (content.byteLength !== version.size || await sha256HexBytes(content) !== version.hash) {
		return corsResponse({ error: 'Stored file version content failed integrity validation' }, 503);
	}

	const previous = await getStoredFileRow(db, path);
	// Expiry cleanup may already own the retained key. Never make it live again.
	const objectKey = createManagedObjectKey(version.hash);
	try {
		await trackStagedUpload(db, objectKey);
	await bucket.put(objectKey, content, {
			httpMetadata: object.httpMetadata,
			customMetadata: { hash: version.hash },
		});
		const result = await commitStagedFile(bucket, db, {
			path,
			hash: version.hash,
			size: content.byteLength,
			objectKey,
			content,
			expectedHash,
			expectedRevision: expectedRevision ?? undefined,
			operation,
			previousFile: previous,
		});
		if (!result.committed) {
			return corsResponse(result.failure ?? { error: 'Remote file changed before the version could be restored', currentHash: result.currentHash }, 409);
		}
		return corsResponse({ success: true, path, hash: version.hash, revision: result.revision });
	} catch (error) {
		if (error instanceof FileNamespaceConflictError) return error.toResponse();
		// A failed response may follow a successful commit. Leave the fresh key
		// for reference-aware orphan cleanup rather than risking live content.
		return corsResponse({ error: 'Restore outcome is unconfirmed. Retry the same saved restore operation.' }, 503);
	}
}
