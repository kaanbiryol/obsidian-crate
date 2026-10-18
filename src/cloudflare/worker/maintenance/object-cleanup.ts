import { changedRows, queryRows } from '../db';
import { findReferencedStorageKeys, type ObjectReference } from '../storage-references';

// R2 deletes up to 1,000 keys per call. 500 keeps the reference lookup's single
// JSON parameter below D1's 2 MB value limit, even with 1,024-character paths.
const CLEANUP_BATCH_LIMIT = 500;

async function queueObjectCleanup(db: D1Database, objects: ObjectReference[]): Promise<void> {
	if (!objects.length) return;
	await db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue(storage_key, file_path)
		SELECT json_extract(value, '$.storageKey'), json_extract(value, '$.path') FROM json_each(?)`)
		.bind(JSON.stringify(objects)).run();
}

/** One statement per batch keeps a maintenance pass within the Free plan's 50-query limit. */
async function removeQueuedObjectCleanup(db: D1Database, keys: string[]): Promise<number> {
	return changedRows(await db.prepare('DELETE FROM object_cleanup_queue WHERE storage_key IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(keys)).run());
}

async function deleteQueuedBucketObjects(
	bucket: R2Bucket,
	db: D1Database,
	objects: ObjectReference[],
): Promise<number> {
	const uniqueKeys = [...new Set(objects.map(object => object.storageKey).filter(Boolean))];
	if (uniqueKeys.length === 0) return 0;

	const referenced = await findReferencedStorageKeys(db, objects);
	const unused = uniqueKeys.filter(key => !referenced.has(key));
	if (unused.length > 0) await bucket.delete(unused.length === 1 ? unused[0]! : unused);
	// Referenced keys must leave this queue as well; their eventual expiry
	// creates a new cleanup intent after the reference is removed.
	await db.prepare('DELETE FROM staged_uploads WHERE storage_key IN (SELECT value FROM json_each(?))')
		.bind(JSON.stringify(uniqueKeys)).run();
	return removeQueuedObjectCleanup(db, uniqueKeys);
}

/** Scheduled failures reach the maintenance error recorder; queued keys retry later.
 * Rowid order is insertion order and reads the table without a sort. */
export async function drainObjectCleanupQueue(bucket: R2Bucket, db: D1Database): Promise<number> {
	const rows = await queryRows<{ storage_key: string; file_path: string }>(
		db.prepare('SELECT storage_key, file_path FROM object_cleanup_queue ORDER BY rowid LIMIT ?')
			.bind(CLEANUP_BATCH_LIMIT),
	);
	return deleteQueuedBucketObjects(bucket, db, rows.map(row => ({ storageKey: row.storage_key, path: row.file_path })));
}

// The queue drains 500 objects per pass; larger batches only grow its backlog.
const EXPIRED_VERSION_BATCH = 1000;

/** Moves the oldest expired versions in one transaction. Returns true when more may remain. */
export async function enqueueExpiredFileVersions(db: D1Database, now = Date.now()): Promise<boolean> {
	const expired = `SELECT storage_key FROM file_versions WHERE expires_at <= ? ORDER BY expires_at LIMIT ${EXPIRED_VERSION_BATCH}`;
	const [, removed] = await db.batch([
		db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key, file_path)
			SELECT storage_key, path FROM file_versions WHERE storage_key IN (${expired})`).bind(now),
		db.prepare(`DELETE FROM file_versions WHERE storage_key IN (${expired})`).bind(now),
	]);
	return changedRows(removed) === EXPIRED_VERSION_BATCH;
}

/** Cleanup must never turn an already-committed file mutation into a failure. */
export async function deleteBucketObjectsOrQueue(
	bucket: R2Bucket,
	db: D1Database,
	keys: ObjectReference[],
): Promise<void> {
	const objects = keys.filter(object => object.storageKey.length > 0);
	try { await queueObjectCleanup(db, objects); }
	catch { /* Still attempt reference-aware deletion if queueing is unavailable. */ }
	try { await deleteQueuedBucketObjects(bucket, db, objects); }
	catch { /* Queued cleanup and staged-upload maintenance retain retry ownership. */ }
}
