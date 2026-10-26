import { changedRows } from '../db';
import { OPERATION_FLOOR } from '../operation-receipts';
import { pruneEncryptionPairings } from '../encryption/pairing';
import { OPERATION_ID_TAG } from '../../../protocol/reminder-operation';

/** Publish the retry floor and prune receipts in the same transaction. */
// Primary-key range deletes; uploads create one receipt each, so a pass must
// outpace a busy day's growth.
export const RECEIPT_BATCH = 5000;

/** Returns true when an expired upload or reminder receipt range may remain. */
export async function pruneOperationReceipts(db: D1Database): Promise<boolean> {
	await pruneEncryptionPairings(db);
	// IDs sort by creation day; every ID created before the floor day sorts below this prefix.
	const tag = `'${OPERATION_ID_TAG}'`;
	const prefix = `${tag} || printf('%08d', ${OPERATION_FLOOR}) || '_'`;
	const results = await db.batch([
		db.prepare(`DELETE FROM reading_operations WHERE day < ${OPERATION_FLOOR}`),
		db.prepare('DELETE FROM reading_handoffs WHERE expires_at < ?').bind(Date.now()),
		db.prepare('DELETE FROM reading_enrollments WHERE expires_at < ?').bind(Date.now()),
		db.prepare(`INSERT INTO maintenance_state (key, value) VALUES ('reminder_operation_floor', ${OPERATION_FLOOR})
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`),
		db.prepare(`DELETE FROM reminder_operations WHERE operation_id IN (
			SELECT operation_id FROM reminder_operations WHERE operation_id >= ${tag} AND operation_id < ${prefix}
			ORDER BY operation_id LIMIT ${RECEIPT_BATCH})`),
		db.prepare(`DELETE FROM upload_operations WHERE operation_id IN (
			SELECT operation_id FROM upload_operations WHERE operation_id >= ${tag} AND operation_id < ${prefix}
			ORDER BY operation_id LIMIT ${RECEIPT_BATCH})`),
		db.prepare(`DELETE FROM reminder_identities WHERE reminder_id IN (
			SELECT i.reminder_id FROM reminder_identities i WHERE i.reminder_id >= ${tag} AND i.reminder_id < ${prefix}
			AND NOT EXISTS (SELECT 1 FROM reminder_sources s WHERE s.reminder_id = i.reminder_id)
			ORDER BY i.reminder_id LIMIT 500)`),
	]);
	return changedRows(results[4]) === RECEIPT_BATCH || changedRows(results[5]) === RECEIPT_BATCH;
}
