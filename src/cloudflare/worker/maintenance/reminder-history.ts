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
