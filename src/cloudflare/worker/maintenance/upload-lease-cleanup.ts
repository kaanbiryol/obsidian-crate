import { queryRows } from '../d1/db';
import { findReferencedStorageKeys, type ObjectReference } from '../d1/storage-references';
import { UPLOAD_LEASE_TTL_MS } from '../sync/staging/upload-leases';

/** Leases and objects one pass claims: two full batch leases, or up to ten single uploads.
 * This bounds the R2 requests and keeps the D1 work at three queries. */
const CLAIMED_LEASES = 10;
const CLAIMED_OBJECTS = 64;
/** Checks before a lease whose object could not be confirmed stops retrying and is
 * listed in diagnostics. */
const MAX_ATTEMPTS = 8;

/** Deletes claimed objects that nothing references. Referenced and deleted keys are
 * finished; an absent object may still be uploading, so it waits like a failed request. */
async function deleteClaimedObjects(bucket: R2Bucket, db: D1Database, objects: ObjectReference[]): Promise<{ waiting: Set<string> }> {
	const referenced = await findReferencedStorageKeys(db, objects);
	const visible: string[] = [];
	const waiting = new Set<string>();
	await Promise.all([...new Set(objects.map(object => object.storageKey))].filter(key => !referenced.has(key)).map(async key => {
		try { if (await bucket.head(key)) visible.push(key); else waiting.add(key); }
		catch { waiting.add(key); }
	}));
	try {
		if (visible.length) await bucket.delete(visible);
	} catch { for (const key of visible) waiting.add(key); }
	return { waiting };
}

/** Claim before checking R2: an expired lease cannot publish after this point. A lease
 * whose objects are all finished is removed; one with absent objects keeps only those,
 * fenced against publication, and retries up to eight times. Returns the objects finished. */
export async function cleanUploadLeases(bucket: R2Bucket, db: D1Database, now = Date.now()): Promise<number> {
	const rows = await queryRows<{ id: string; keys: string }>(db.prepare(`UPDATE upload_leases SET state = 'deleting'
    WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER claimed AS position,
        SUM(json_array_length(keys)) OVER claimed AS objects
      FROM upload_leases WHERE expires_at <= ? WINDOW claimed AS (ORDER BY expires_at, id) ORDER BY expires_at, id LIMIT ${CLAIMED_LEASES})
      WHERE position = 1 OR objects <= ${CLAIMED_OBJECTS})
    RETURNING id, keys`).bind(now));
	if (!rows.length) return 0;
	const leases = rows.map(row => ({ ...row, objects: JSON.parse(row.keys) as ObjectReference[] }));
	const { waiting } = await deleteClaimedObjects(bucket, db, leases.flatMap(lease => lease.objects));
	let finished = 0;
	// A claimed lease never gains keys, and a commit that settled some of them meanwhile only
	// removed them. Each lease keeps just its current keys that are still waiting.
	await db.batch(leases.flatMap(lease => {
		const left = lease.objects.filter(object => waiting.has(object.storageKey));
		finished += lease.objects.length - left.length;
		if (!left.length) return [db.prepare('DELETE FROM upload_leases WHERE id = ?').bind(lease.id)];
		return [db.prepare(`UPDATE upload_leases SET keys = (SELECT json_group_array(json(k.value)) FROM json_each(upload_leases.keys) k
        WHERE json_extract(k.value, '$.storageKey') IN (SELECT value FROM json_each(?))),
      attempts = attempts + 1, expires_at = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN NULL ELSE ? END
      WHERE id = ?`).bind(JSON.stringify(left.map(object => object.storageKey)), now + UPLOAD_LEASE_TTL_MS, lease.id),
		db.prepare('DELETE FROM upload_leases WHERE id = ? AND json_array_length(keys) = 0').bind(lease.id)];
	}));
	return finished;
}
