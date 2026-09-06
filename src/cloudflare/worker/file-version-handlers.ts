import { sha256HexBytes } from './auth';
import { corsResponse } from './cors';
import { queryRows } from './db';
import { commitStagedFile } from './sync-mutations';
import {
	createManagedObjectKey,
	MAX_FILE_BYTES,
	getStoredFileRow,
	storedObjectMatchesMetadata,
} from './sync-storage';
import { parseExpectedFileHash } from './sync-storage';
import { parseJsonObject, parseOptionalString, sanitizePath } from './utils';

interface FileVersionRow {
	storage_key: string;
	path: string;
	hash: string;
	size: number;
	reason: 'replaced' | 'deleted';
	created_at: string;
	expires_at: number;
}

export async function handleListFileVersions(request: Request, db: D1Database): Promise<Response> {
	const rawPath = new URL(request.url).searchParams.get('path');
	const path = rawPath === null ? null : sanitizePath(rawPath);
	if (rawPath !== null && !path) return corsResponse({ error: 'Invalid path' }, 400);

	const rows = path
		? await queryRows<FileVersionRow>(db.prepare(`SELECT storage_key, path, hash, size, reason, created_at, expires_at
			FROM file_versions WHERE path = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 100`).bind(path, Date.now()))
		: await queryRows<FileVersionRow>(db.prepare(`SELECT storage_key, path, hash, size, reason, created_at, expires_at
			FROM file_versions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 100`).bind(Date.now()));
	return corsResponse({ versions: rows });
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
	if (!storageKey || expectedHash === undefined) {
		return corsResponse({ error: 'storageKey and expectedHash are required' }, 400);
	}

	const version = await db.prepare(`SELECT storage_key, path, hash, size, reason, created_at, expires_at
		FROM file_versions WHERE storage_key = ? AND expires_at > ?`).bind(storageKey, Date.now()).first<FileVersionRow>();
	if (!version) return corsResponse({ error: 'File version not found or expired' }, 404);
	const path = sanitizePath(version.path);
	if (!path) return corsResponse({ error: 'Stored file version has an invalid path' }, 409);

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
			previousFile: previous,
		});
		if (!result.committed) {
			return corsResponse({
				error: 'Remote file changed before the version could be restored',
				currentHash: result.currentHash,
			}, 409);
		}
	} catch {
		// A failed response may follow a successful commit. Leave the fresh key
		// for reference-aware orphan cleanup rather than risking live content.
		return corsResponse({ error: 'Unable to restore file version; retry the request' }, 503);
	}
	return corsResponse({ success: true, path, hash: version.hash, size: content.byteLength });
}
