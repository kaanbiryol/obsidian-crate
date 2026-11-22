import { trackUploadLease } from '../staging/upload-leases';
import { beginUploadOperation } from '../upload-operations';
import { isSyncRevision } from '@/protocol/sync-validation';
import { corsResponse } from '../../http/cors';
import { commitStagedFile } from '../mutations';
import { FileNamespaceConflictError } from '../file-namespace';
import { ENCRYPTED_FILE_CONTENT_TYPE, fileTransportLimit } from '../../../../encryption/file-format';
import { MAX_BUFFERED_FILE_BYTES, MAX_CONFIGURABLE_FILE_BYTES } from '../../../../protocol/sync-limits';
import { copyObjectInParts } from '../upload-sessions';
import {
	storedObjectMatchesMetadata,
} from '../storage';
import { FILE_VERSION_CUTOFF_SQL, parseExpectedFileHash } from '../storage';
import { parseJsonObject, parseOptionalString, sanitizePath } from '../../http/request-validation';
import { createManagedObjectKey } from '@/protocol/storage-keys';
import { sha256Hex } from '@/platform/sha256';
export { handleListFileVersions } from './list';

interface FileVersionRow {
	storage_key: string;
	path: string;
	hash: string;
	size: number;
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
	if (!parsedBody.value.operationId || !isSyncRevision(storageKey) || !path || expectedHash === undefined
		|| expectedRevision === undefined || (expectedHash === null ? expectedRevision !== null : expectedRevision === null)) {
		return corsResponse({ error: 'A restore operation, retained version, path and current file precondition are required' }, 400);
	}
	// Resolve receipts before reading retained bytes: the original version may
	// expire after commitment, and later edits/deletes must never be replayed over.
	const operation = await beginUploadOperation(db, parsedBody.value.operationId,
		{ kind: 'restore', path, storageKey, expectedHash, expectedRevision });
	if (operation instanceof Response) return operation;

	const version = await db.prepare(`SELECT storage_key, path, hash, size
		FROM file_versions WHERE storage_key = ? AND kept_at > ${FILE_VERSION_CUTOFF_SQL}`).bind(storageKey, Date.now()).first<FileVersionRow>();
	if (!version) return corsResponse({ error: 'File version not found or expired' }, 404);
	if (version.path !== path) return corsResponse({ error: 'Retained version does not belong to the requested path' }, 409);

	const object = await bucket.get(version.storage_key);
	if (!object || object.size > fileTransportLimit(object.httpMetadata?.contentType, MAX_CONFIGURABLE_FILE_BYTES) || !storedObjectMatchesMetadata(object, {
		hash: version.hash,
		size: version.size,
		storageKey: version.storage_key,
	})) {
		return corsResponse({ error: 'Stored file version content is unavailable' }, 503);
	}
	// A file above the buffered limit is a plaintext attachment, copied in parts; nothing
	// at publication reads its bytes.
	const large = __CRATE_SELF_HOSTED__ && version.size > MAX_BUFFERED_FILE_BYTES;
	const content = large ? new ArrayBuffer(0) : await object.arrayBuffer();
	if (!large && (content.byteLength !== version.size || await sha256Hex(content) !== version.hash)) {
		return corsResponse({ error: 'Stored file version content failed integrity validation' }, 503);
	}

	// Expiry cleanup may already own the retained key. Never make it live again.
	const objectKey = createManagedObjectKey(version.hash);
	try {
		const { id: leaseId } = await trackUploadLease(db, [{ storageKey: objectKey, path }], { encrypted: object.httpMetadata?.contentType === ENCRYPTED_FILE_CONTENT_TYPE });
		if (__CRATE_SELF_HOSTED__ && large) {
			await object.body?.cancel();
			const copied = await copyObjectInParts(bucket, version.storage_key, objectKey, version.size, { httpMetadata: object.httpMetadata, customMetadata: { hash: version.hash } });
			if (copied !== version.hash) {
				await bucket.delete(objectKey);
				return corsResponse({ error: 'Stored file version content failed integrity validation' }, 503);
			}
		} else await bucket.put(objectKey, content, {
			httpMetadata: object.httpMetadata,
			customMetadata: { hash: version.hash },
		});
		const result = await commitStagedFile(bucket, db, {
			path,
			hash: version.hash,
			size: version.size,
			objectKey,
			leaseId,
			content,
			expectedHash,
			expectedRevision: expectedRevision ?? undefined,
			operation,
			keepReplacedVersion: true,
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
