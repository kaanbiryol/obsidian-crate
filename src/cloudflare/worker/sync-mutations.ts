import { changedRows } from './db';
import { portablePathKey } from '../../protocol/portable-path';
import {
	collectCleanupKeys,
	deleteBucketObjectsOrQueue,
	FILE_VERSION_RETENTION_MS,
	getStoredFileRow,
	type ExpectedFileHash,
	type FileStorageRow,
} from './sync-storage';

function uploadMutation(
	db: D1Database,
	path: string,
	hash: string,
	size: number,
	objectKey: string,
	expectedHash: ExpectedFileHash,
): D1PreparedStatement {
	if (expectedHash === null) {
		return db.prepare(`INSERT INTO files (path, portable_path, hash, size, modified, storage_key)
			VALUES (?, ?, ?, ?, datetime('now'), ?)
			ON CONFLICT(path) DO NOTHING`)
			.bind(path, portablePathKey(path), hash, size, objectKey);
	}

	return db.prepare(`UPDATE files
		SET portable_path = ?, hash = ?, size = ?, modified = datetime('now'), storage_key = ?
		WHERE path = ? AND hash = ?`)
		.bind(portablePathKey(path), hash, size, objectKey, path, expectedHash);
}

export interface CommitResult {
	committed: boolean;
	currentHash: string | null;
	idempotent?: boolean;
}

export async function commitStagedFile(
	bucket: R2Bucket,
	db: D1Database,
	params: {
		path: string;
		hash: string;
		size: number;
		objectKey: string;
		expectedHash: ExpectedFileHash;
		previousFile: FileStorageRow | null;
	},
): Promise<CommitResult> {
	const cleanupKeys = collectCleanupKeys(params.previousFile, params.objectKey);
	const mutation = uploadMutation(
		db,
		params.path,
		params.hash,
		params.size,
		params.objectKey,
		params.expectedHash,
	);
	const results: unknown[] = await db.batch([
		mutation,
		db.prepare(`INSERT INTO changelog (path, action, hash, size)
			SELECT ?, 'put', ?, ?
			WHERE EXISTS (
				SELECT 1 FROM files WHERE path = ? AND storage_key = ?
			)`).bind(params.path, params.hash, params.size, params.path, params.objectKey),
		...cleanupKeys.map((key) => db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, expires_at)
			SELECT ?, ?, ?, ?, 'replaced', ? WHERE EXISTS (
				SELECT 1 FROM files WHERE path = ? AND storage_key = ?
			)`).bind(
			key,
			params.path,
			params.previousFile?.hash ?? '',
			params.previousFile?.size ?? 0,
			Date.now() + FILE_VERSION_RETENTION_MS,
			params.path,
			params.objectKey,
		)),
	]);

	if (changedRows(results[0]) !== 1) {
		const current = await getStoredFileRow(db, params.path);
		await deleteBucketObjectsOrQueue(bucket, db, [params.objectKey]);
		if (current?.hash === params.hash) {
			return { committed: true, currentHash: current.hash, idempotent: true };
		}
		return { committed: false, currentHash: current?.hash ?? null };
	}

	return { committed: true, currentHash: params.hash };
}

export async function commitFileDelete(
	_bucket: R2Bucket,
	db: D1Database,
	params: {
		path: string;
		expectedHash: ExpectedFileHash;
		previousFile: FileStorageRow | null;
	},
): Promise<CommitResult> {
	const expectedPredicate = params.expectedHash === null
			? 'path = ? AND 0'
			: 'path = ? AND hash = ?';
	const predicateArgs = params.expectedHash === null
		? [params.path]
		: [params.path, params.expectedHash];
	const results: unknown[] = await db.batch([
		db.prepare(`INSERT INTO changelog (path, action, hash, size)
			SELECT path, 'delete', '', 0 FROM files WHERE ${expectedPredicate}`)
			.bind(...predicateArgs),
		db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, expires_at)
			SELECT storage_key, path, hash, size, 'deleted', ? FROM files WHERE ${expectedPredicate}`)
			.bind(Date.now() + FILE_VERSION_RETENTION_MS, ...predicateArgs),
		db.prepare(`DELETE FROM files WHERE ${expectedPredicate}`).bind(...predicateArgs),
	]);

	if (changedRows(results[2]) !== 1) {
		const current = await getStoredFileRow(db, params.path);
		if (!current) {
			return { committed: true, currentHash: null, idempotent: true };
		}
		return { committed: false, currentHash: current.hash };
	}

	return { committed: true, currentHash: null };
}
