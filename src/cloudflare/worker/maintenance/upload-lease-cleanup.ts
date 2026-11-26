import { queryRows } from '../d1/db';
import { SUBREQUESTS_PER_INVOCATION } from '../d1/platform-limits';
import { findReferencedStorageKeys, type ObjectReference } from '../d1/storage-references';
import { UPLOAD_LEASE_TTL_MS } from '../sync/staging/upload-leases';

/** Leases one pass claims. The D1 work stays at three queries whatever their number. */
const CLAIMED_LEASES = 10;
/** Subrequests a maintenance pass makes besides this task's R2 heads: about 28 D1 queries
 * (this task's three among them), three R2 deletes and one coordinator request, as
 * measured by maintenance/object-cleanup.integration.ts. */
const PASS_SUBREQUESTS = 32;
/** Objects one pass checks with an R2 head each, so the whole pass stays within
 * SUBREQUESTS_PER_INVOCATION. The claim stops at this many objects, except that the first
 * lease is always claimed; a larger one is checked over several passes. */
const CHECKED_OBJECTS = SUBREQUESTS_PER_INVOCATION - PASS_SUBREQUESTS;
/** Checks before a lease whose object could not be confirmed stops retrying and is
 * listed in diagnostics. */
const MAX_ATTEMPTS = 8;

/** Deletes claimed objects that nothing references. Referenced and deleted keys are
 * finished; an absent object may still be uploading, so it waits like a failed request.
 * Keys past this pass's head budget are deferred, unchecked, to the next pass. */
async function deleteClaimedObjects(bucket: R2Bucket, db: D1Database, objects: ObjectReference[]): Promise<{ waiting: Set<string>; deferred: Set<string> }> {
	const referenced = await findReferencedStorageKeys(db, objects);
	const visible: string[] = [];
	const waiting = new Set<string>();
	const unreferenced = [...new Set(objects.map(object => object.storageKey))].filter(key => !referenced.has(key));
	const deferred = new Set(unreferenced.slice(CHECKED_OBJECTS));
	await Promise.all(unreferenced.slice(0, CHECKED_OBJECTS).map(async key => {
		try { if (await bucket.head(key)) visible.push(key); else waiting.add(key); }
		catch { waiting.add(key); }
	}));
	try {
		if (visible.length) await bucket.delete(visible);
	} catch { for (const key of visible) waiting.add(key); }
	return { waiting, deferred };
}

/** Claim before checking R2: an expired lease cannot publish after this point. A lease
 * whose objects are all finished is removed; one with absent objects keeps only those,
 * fenced against publication, and retries up to eight times. Deferred objects stay in their
 * claimed, expired lease for the next pass, and the lease's absent objects move to a new
 * lease that retries them. Returns the objects finished and whether deferred ones remain. */
export async function cleanUploadLeases(bucket: R2Bucket, db: D1Database, now = Date.now()): Promise<{ finished: number; more: boolean }> {
	const rows = await queryRows<{ id: string; keys: string }>(db.prepare(`UPDATE upload_leases SET state = 'deleting'
    WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER claimed AS position,
        SUM(json_array_length(keys)) OVER claimed AS objects
      FROM upload_leases WHERE expires_at <= ? WINDOW claimed AS (ORDER BY expires_at, id) ORDER BY expires_at, id LIMIT ${CLAIMED_LEASES})
      WHERE position = 1 OR objects <= ${CHECKED_OBJECTS})
    RETURNING id, keys`).bind(now));
	if (!rows.length) return { finished: 0, more: false };
	const leases = rows.map(row => ({ ...row, objects: JSON.parse(row.keys) as ObjectReference[] }));
	const { waiting, deferred } = await deleteClaimedObjects(bucket, db, leases.flatMap(lease => lease.objects));
	let finished = 0;
	// A claimed lease never gains keys, and a commit that settled some of them meanwhile only
	// removed them. Each lease keeps just its current keys that are still waiting or deferred.
	const currentKeys = (lease: string) => `(SELECT json_group_array(json(k.value)) FROM json_each(${lease}.keys) k
        WHERE json_extract(k.value, '$.storageKey') IN (SELECT value FROM json_each(?)))`;
	const keyList = (objects: ObjectReference[]) => JSON.stringify(objects.map(object => object.storageKey));
	await db.batch(leases.flatMap(lease => {
		const left = lease.objects.filter(object => waiting.has(object.storageKey));
		const later = lease.objects.filter(object => deferred.has(object.storageKey));
		finished += lease.objects.length - left.length - later.length;
		if (!left.length && !later.length) return [db.prepare('DELETE FROM upload_leases WHERE id = ?').bind(lease.id)];
		if (!later.length) {
			return [db.prepare(`UPDATE upload_leases SET keys = ${currentKeys('upload_leases')},
      attempts = attempts + 1, expires_at = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN NULL ELSE ? END
      WHERE id = ?`).bind(keyList(left), now + UPLOAD_LEASE_TTL_MS, lease.id),
			db.prepare('DELETE FROM upload_leases WHERE id = ? AND json_array_length(keys) = 0').bind(lease.id)];
		}
		const split = crypto.randomUUID();
		return [
			...left.length ? [db.prepare(`INSERT INTO upload_leases(id, keys, state, attempts, expires_at)
      SELECT ?, ${currentKeys('l')}, 'deleting', l.attempts + 1, CASE WHEN l.attempts + 1 >= ${MAX_ATTEMPTS} THEN NULL ELSE ? END
      FROM upload_leases l WHERE l.id = ?`).bind(split, keyList(left), now + UPLOAD_LEASE_TTL_MS, lease.id)] : [],
			db.prepare(`UPDATE upload_leases SET keys = ${currentKeys('upload_leases')} WHERE id = ?`).bind(keyList(later), lease.id),
			db.prepare('DELETE FROM upload_leases WHERE id IN (?, ?) AND json_array_length(keys) = 0').bind(lease.id, split),
		];
	}));
	return { finished, more: deferred.size > 0 };
}
