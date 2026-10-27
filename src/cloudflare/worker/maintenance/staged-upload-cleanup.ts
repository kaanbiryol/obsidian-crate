import { queryRows } from '../db';
import { findReferencedStorageKeys, type ObjectReference } from '../storage-references';
import { STAGED_UPLOAD_TTL_MS } from '../sync/staging/staged-uploads';

/** Deletes claimed staged objects that nothing references. Referenced and deleted keys are
 * finished; an absent object may still be uploading, so it waits like a failed request. */
export async function deleteClaimedObjects(bucket: R2Bucket, db: D1Database, objects: ObjectReference[]): Promise<{ finished: string[]; waiting: string[] }> {
	const referenced = await findReferencedStorageKeys(db, objects);
	const visible: string[] = [];
	const waiting: string[] = [];
	await Promise.all(objects.map(object => object.storageKey).filter(key => !referenced.has(key)).map(async key => {
		try { (await bucket.head(key) ? visible : waiting).push(key); }
		catch { waiting.push(key); }
	}));
	try {
		if (visible.length) await bucket.delete(visible);
	} catch { return { finished: [...referenced], waiting: [...waiting, ...visible] }; }
	return { finished: [...referenced, ...visible], waiting };
}

/** Claim before checking R2: expired leases cannot publish after this point. */
export async function cleanStagedUploads(bucket: R2Bucket, db: D1Database, now = Date.now()): Promise<number> {
	const rows = await queryRows<{ storage_key: string; file_path: string }>(db.prepare(`UPDATE staged_uploads SET state = 'deleting'
    WHERE storage_key IN (SELECT storage_key FROM staged_uploads WHERE expires_at <= ?
      ORDER BY expires_at, storage_key LIMIT 10) RETURNING storage_key, file_path`).bind(now));
	if (!rows.length) return 0;
	const { finished, waiting } = await deleteClaimedObjects(bucket, db, rows.map(row => ({ storageKey: row.storage_key, path: row.file_path })));
	await db.batch([
		db.prepare('DELETE FROM staged_uploads WHERE storage_key IN (SELECT value FROM json_each(?))')
			.bind(JSON.stringify(finished)),
		// An absent object may still be uploading. Keep its record instead of losing a late write.
		db.prepare(`UPDATE staged_uploads SET attempts = attempts + 1,
      expires_at = CASE WHEN attempts + 1 >= 8 THEN NULL ELSE ? END,
      last_error = 'Object cleanup could not be confirmed; the upload record is retained'
      WHERE storage_key IN (SELECT value FROM json_each(?))`)
			.bind(now + STAGED_UPLOAD_TTL_MS, JSON.stringify(waiting)),
	]);
	return finished.length;
}
