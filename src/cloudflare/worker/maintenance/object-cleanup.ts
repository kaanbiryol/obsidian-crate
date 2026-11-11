import { changedRows, queryRows, type SqlGuard } from '../d1/db';
import { findReferencedStorageKeys, type ObjectReference } from '../d1/storage-references';

// R2 deletes up to R2_KEYS_PER_CALL keys per call. 500 keeps the reference lookup's single
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
 * Key order reads the table without a sort; every drained key leaves the queue. */
export async function drainObjectCleanupQueue(bucket: R2Bucket, db: D1Database): Promise<number> {
	const rows = await queryRows<{ storage_key: string; file_path: string }>(
		db.prepare('SELECT storage_key, file_path FROM object_cleanup_queue ORDER BY storage_key LIMIT ?')
			.bind(CLEANUP_BATCH_LIMIT),
	);
	return deleteQueuedBucketObjects(bucket, db, rows.map(row => ({ storageKey: row.storage_key, path: row.file_path })));
}

// Matches the cleanup queue's batch, which keeps the key list below D1's value limit.
const EXPIRED_VERSION_BATCH = CLEANUP_BATCH_LIMIT;

/** Deletes the objects of the oldest expired versions, then their rows. The expired row
 * is the cleanup intent: every reader already hides it, and a pass interrupted after the
 * R2 delete repeats it. Keys are never reused, so only a live file can still need one.
 * `alongside` runs in the row deletion's transaction, given the storage keys. Returns
 * true when more may remain. */
export async function expireFileVersions(bucket: R2Bucket, db: D1Database, now = Date.now(),
	alongside?: (expired: SqlGuard<unknown>) => D1PreparedStatement): Promise<boolean> {
	const rows = await queryRows<{ storage_key: string; path: string }>(db.prepare(`SELECT storage_key, path FROM file_versions
    WHERE expires_at <= ? ORDER BY expires_at LIMIT ${EXPIRED_VERSION_BATCH}`).bind(now));
	if (!rows.length) return false;
	const live = await findReferencedStorageKeys(db, rows.map(row => ({ storageKey: row.storage_key, path: row.path })), { versions: false });
	const unused = rows.map(row => row.storage_key).filter(key => !live.has(key));
	if (unused.length) await bucket.delete(unused);
	const expired: SqlGuard<unknown> = { sql: 'SELECT value FROM json_each(?)', args: [JSON.stringify(rows.map(row => row.storage_key))] };
	await db.batch([
		...(alongside ? [alongside(expired)] : []),
		db.prepare(`DELETE FROM file_versions WHERE storage_key IN (${expired.sql}) AND expires_at <= ?`).bind(...expired.args, now),
	]);
	return rows.length === EXPIRED_VERSION_BATCH;
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
