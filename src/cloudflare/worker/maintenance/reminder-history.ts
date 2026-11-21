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

/** Rows a pass removes from the cache of folders nothing reads any more, about 4,000 row writes. */
const ORPHAN_REMINDER_CACHE_BATCH = 2000;

/** Parsed-note cache rows of a folder neither the reminder policy nor any credential
 * names, such as the previous folder after the setting changes. The cache is rebuilt on
 * demand, so removing a row only costs a re-parse. */
export async function pruneOrphanReminderCache(db: D1Database): Promise<void> {
	await db.prepare(`DELETE FROM reminder_file_cache WHERE rowid IN (
		SELECT rowid FROM reminder_file_cache WHERE folder_path NOT IN (
			SELECT folder_path FROM notification_policy
			UNION SELECT folder_path FROM auth_tokens WHERE folder_path IS NOT NULL)
		LIMIT ${ORPHAN_REMINDER_CACHE_BATCH}
	)`).run();
}
