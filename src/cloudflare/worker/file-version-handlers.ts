import { portablePathKey } from '../../protocol/portable-path';
import { sha256HexBytes } from './auth';
import { corsResponse } from './cors';
import { changedRows, queryRows } from './db';
import {
	FILE_VERSION_RETENTION_MS,
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
	if (!object || !storedObjectMatchesMetadata(object, {
		hash: version.hash,
		size: version.size,
		storageKey: version.storage_key,
	})) {
		return corsResponse({ error: 'Stored file version content is unavailable' }, 503);
	}
	if (await sha256HexBytes(await object.arrayBuffer()) !== version.hash) {
		return corsResponse({ error: 'Stored file version content failed integrity validation' }, 503);
	}

	const previous = await getStoredFileRow(db, path);
	const mutation = expectedHash === null
		? db.prepare(`INSERT INTO files (path, portable_path, hash, size, modified, storage_key)
			VALUES (?, ?, ?, ?, datetime('now'), ?) ON CONFLICT(path) DO NOTHING`)
			.bind(path, portablePathKey(path), version.hash, version.size, version.storage_key)
		: db.prepare(`UPDATE files SET portable_path = ?, hash = ?, size = ?, modified = datetime('now'), storage_key = ?
			WHERE path = ? AND hash = ?`)
			.bind(portablePathKey(path), version.hash, version.size, version.storage_key, path, expectedHash);
	const statements = [
		mutation,
		db.prepare(`INSERT INTO changelog (path, action, hash, size)
			SELECT ?, 'put', ?, ? WHERE EXISTS
			(SELECT 1 FROM files WHERE path = ? AND storage_key = ?)`)
			.bind(path, version.hash, version.size, path, version.storage_key),
		db.prepare(`DELETE FROM file_versions WHERE storage_key = ? AND EXISTS
			(SELECT 1 FROM files WHERE path = ? AND storage_key = ?)`)
			.bind(version.storage_key, path, version.storage_key),
	];
	if (previous && previous.storageKey !== version.storage_key) {
		statements.push(db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, expires_at)
			SELECT ?, ?, ?, ?, 'replaced', ? WHERE EXISTS
			(SELECT 1 FROM files WHERE path = ? AND storage_key = ?)`)
			.bind(
				previous.storageKey,
				path,
				previous.hash,
				previous.size,
				Date.now() + FILE_VERSION_RETENTION_MS,
				path,
				version.storage_key,
			));
	}

	const results: unknown[] = await db.batch(statements);
	if (changedRows(results[0]) !== 1) {
		const current = await getStoredFileRow(db, path);
		if (current?.hash === version.hash && current.storageKey === version.storage_key) {
			return corsResponse({ success: true, path, hash: version.hash, size: version.size });
		}
		return corsResponse({
			error: 'Remote file changed before the version could be restored',
			currentHash: current?.hash ?? null,
		}, 409);
	}
	return corsResponse({ success: true, path, hash: version.hash, size: version.size });
}
