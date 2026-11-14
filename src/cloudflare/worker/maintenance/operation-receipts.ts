import { changedRows } from '../d1/db';
import { OPERATION_FLOOR, OPERATION_FLOOR_KEY, UPLOAD_OPERATION_FLOOR, UPLOAD_OPERATION_FLOOR_KEY } from '../d1/operation-receipts';
import { OPERATION_ID_TAG } from '../../../protocol/reminder-operation';

/** Publish each retry floor and prune its receipts in the same transaction. Upload
 * receipts expire after 30 days, reminder and Reading receipts after 180. */
// Primary-key range deletes; uploads create one receipt each, so a pass must
// outpace a busy day's growth.
export const RECEIPT_BATCH = 5000;

/** Returns true when an expired receipt range of any kind may remain. Create
 * identities still referenced by a source are rescanned on every prune, so they are
 * pruned only when `identities` is true, once per maintenance episode. */
export async function pruneOperationReceipts(db: D1Database, identities = true): Promise<boolean> {
	// IDs sort by creation day; every ID created before the floor day sorts below this prefix.
	const tag = `'${OPERATION_ID_TAG}'`;
	const prefix = `${tag} || printf('%08d', ${OPERATION_FLOOR}) || '_'`;
	const uploadPrefix = `${tag} || printf('%08d', ${UPLOAD_OPERATION_FLOOR}) || '_'`;
	const expired = (kind: string, below: string) => `kind = '${kind}' AND operation_id >= ${tag} AND operation_id < ${below}`;
	const publishFloor = (key: string, floor: string) => db.prepare(`INSERT INTO maintenance_state (key, value) VALUES ('${key}', ${floor})
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
	const prune = (kind: string, below: string) => [
		db.prepare(`DELETE FROM operations WHERE kind = '${kind}' AND operation_id IN (
			SELECT operation_id FROM operations WHERE ${expired(kind, below)} ORDER BY operation_id LIMIT ${RECEIPT_BATCH})`),
		// A chunk is written in the same batch as its receipt, and no receipt is written below a
		// published floor, so only this prune leaves chunks without a receipt.
		db.prepare(`DELETE FROM operation_chunks WHERE ${expired(kind, below)} AND NOT EXISTS (SELECT 1 FROM operations o
			WHERE o.kind = operation_chunks.kind AND o.operation_id = operation_chunks.operation_id)`),
	];
	const results = await db.batch([
		publishFloor(OPERATION_FLOOR_KEY, OPERATION_FLOOR),
		...prune('reading', prefix),
		...prune('reminder', prefix),
		publishFloor(UPLOAD_OPERATION_FLOOR_KEY, UPLOAD_OPERATION_FLOOR),
		...prune('upload', uploadPrefix),
		...(identities ? [db.prepare(`DELETE FROM reminder_identities WHERE reminder_id IN (
			SELECT i.reminder_id FROM reminder_identities i WHERE i.reminder_id >= ${tag} AND i.reminder_id < ${prefix}
			AND NOT EXISTS (SELECT 1 FROM reminder_sources s WHERE s.reminder_id = i.reminder_id)
			ORDER BY i.reminder_id LIMIT 500)`)] : []),
	]);
	return [results[1], results[3], results[6]].some(result => changedRows(result) === RECEIPT_BATCH);
}
