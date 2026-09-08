import { REMINDER_OPERATION_FLOOR } from '../reminders-web/operation-expiry';

/**
 * Only forgotten occurrences far outside the 24-hour delivery window expire.
 * Source references include quarantined files and survive parser upgrades.
 * Mutation receipts and create identities have different retry guarantees.
 */
export async function pruneReminderOccurrences(db: D1Database): Promise<void> {
	await db.prepare(`DELETE FROM reminder_occurrences WHERE (reminder_id, due_key) IN (
		SELECT o.reminder_id, o.due_key FROM reminder_occurrences o
		WHERE o.first_seen_at < (unixepoch('now') - 180 * 86400) * 1000
		AND julianday(o.due_key) < julianday('now', '-180 days')
		AND NOT EXISTS (SELECT 1 FROM reminder_sources s
			WHERE s.reminder_id = o.reminder_id AND s.due_key = o.due_key)
		ORDER BY o.first_seen_at LIMIT 500
	)`).run();
}

/** Expiration is published before deleting receipts, in the same transaction. */
export async function pruneReminderOperations(db: D1Database): Promise<void> {
	const prefix = `'e1_' || printf('%08d', ${REMINDER_OPERATION_FLOOR}) || '_'`;
	await db.batch([
		db.prepare(`INSERT INTO maintenance_state (key, value) VALUES ('reminder_operation_floor', ${REMINDER_OPERATION_FLOOR})
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`),
		db.prepare(`DELETE FROM reminder_operations WHERE operation_id IN (
			SELECT operation_id FROM reminder_operations WHERE operation_id >= 'e1_' AND operation_id < ${prefix}
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
