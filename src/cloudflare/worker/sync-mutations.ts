import { changedRows } from './db';
import {
	collectCleanupKeys,
	deleteBucketObjectsOrQueue,
	deleteQueuedBucketObjects,
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
		return db.prepare(`INSERT INTO files (path, hash, size, modified, storage_key)
			VALUES (?, ?, ?, datetime('now'), ?)
			ON CONFLICT(path) DO NOTHING`)
			.bind(path, hash, size, objectKey);
	}

	return db.prepare(`UPDATE files
		SET hash = ?, size = ?, modified = datetime('now'), storage_key = ?
		WHERE path = ? AND hash = ?`)
		.bind(hash, size, objectKey, path, expectedHash);
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
		...cleanupKeys.map((key) => db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key)
			SELECT ? WHERE EXISTS (
				SELECT 1 FROM files WHERE path = ? AND storage_key = ?
			)`).bind(key, params.path, params.objectKey)),
	]);

	if (changedRows(results[0]) !== 1) {
		const current = await getStoredFileRow(db, params.path);
		await deleteBucketObjectsOrQueue(bucket, db, [params.objectKey]);
		if (current?.hash === params.hash) {
			return { committed: true, currentHash: current.hash, idempotent: true };
		}
		return { committed: false, currentHash: current?.hash ?? null };
	}

	await deleteQueuedBucketObjects(
		bucket,
		db,
		cleanupKeys,
	);
	return { committed: true, currentHash: params.hash };
}

export async function commitFileDelete(
	bucket: R2Bucket,
	db: D1Database,
	params: {
		path: string;
		expectedHash: ExpectedFileHash;
		previousFile: FileStorageRow | null;
	},
): Promise<CommitResult> {
	const cleanupKeys = collectCleanupKeys(params.previousFile);
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
		db.prepare(`DELETE FROM files WHERE ${expectedPredicate}`).bind(...predicateArgs),
		...cleanupKeys.map((key) => db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key)
			SELECT ? WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ?)`)
			.bind(key, params.path)),
	]);

	if (changedRows(results[1]) !== 1) {
		const current = await getStoredFileRow(db, params.path);
		if (!current) {
			await deleteBucketObjectsOrQueue(bucket, db, cleanupKeys);
			return { committed: true, currentHash: null, idempotent: true };
		}
		return { committed: false, currentHash: current.hash };
	}

	await deleteQueuedBucketObjects(bucket, db, cleanupKeys);
	return { committed: true, currentHash: null };
}
