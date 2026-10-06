import { OPERATION_FLOOR } from '../operation-expiry';
import { pruneEncryptionPairings } from '../encryption-pairing';

/** Publish the retry floor and prune receipts in the same transaction. */
export async function pruneOperationReceipts(db: D1Database): Promise<void> {
	await pruneEncryptionPairings(db);
	const prefix = `'e1_' || printf('%08d', ${OPERATION_FLOOR}) || '_'`;
	await db.batch([
		db.prepare(`DELETE FROM reading_operations WHERE day < ${OPERATION_FLOOR}`),
		db.prepare('DELETE FROM reading_handoffs WHERE expires_at < ?').bind(Date.now()),
		db.prepare('DELETE FROM reading_enrollments WHERE expires_at < ?').bind(Date.now()),
		db.prepare(`INSERT INTO maintenance_state (key, value) VALUES ('reminder_operation_floor', ${OPERATION_FLOOR})
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`),
		db.prepare(`DELETE FROM reminder_operations WHERE operation_id IN (
			SELECT operation_id FROM reminder_operations WHERE operation_id >= 'e1_' AND operation_id < ${prefix}
			ORDER BY operation_id LIMIT 500)`),
		db.prepare(`DELETE FROM upload_operations WHERE operation_id IN (
			SELECT operation_id FROM upload_operations WHERE operation_id >= 'e1_' AND operation_id < ${prefix}
			ORDER BY operation_id LIMIT 500)`),
		// Legacy callers are fenced by protocol 6. Their finite history remains
		// replayable until cleanup, then a missing unversioned ID always fails.
		db.prepare(`DELETE FROM reminder_operations WHERE operation_id IN (
			SELECT operation_id FROM reminder_operations WHERE created_at < datetime('now', '-180 days')
			AND operation_id NOT GLOB 'e1_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*'
			ORDER BY created_at LIMIT 500)`),
		db.prepare(`DELETE FROM reminder_identities WHERE reminder_id IN (
			SELECT i.reminder_id FROM reminder_identities i WHERE i.reminder_id >= 'e1_' AND i.reminder_id < ${prefix}
			AND NOT EXISTS (SELECT 1 FROM reminder_sources s WHERE s.reminder_id = i.reminder_id)
			ORDER BY i.reminder_id LIMIT 500)`),
	]);
}
