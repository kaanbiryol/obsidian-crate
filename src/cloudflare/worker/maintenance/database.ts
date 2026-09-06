export async function pruneExpiredTokens(db: D1Database, now = Date.now()): Promise<void> {
	await db.batch([
        db.prepare('DELETE FROM push_subscriptions WHERE owner_token_id IN (SELECT id FROM auth_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?)').bind(now),
		db.prepare('DELETE FROM auth_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now),
		db.prepare('DELETE FROM web_enrollment_tokens WHERE expires_at <= ?').bind(now),
	]);
}

export async function recordMaintenanceRun(
	db: D1Database,
	errors: string[] = [],
	timestamp = new Date().toISOString(),
): Promise<void> {
	await db.batch([
		db.prepare(`INSERT INTO maintenance_state (key, value, updated_at)
			VALUES ('last_run', ?, datetime('now'))
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
			.bind(timestamp),
		errors.length > 0
			? db.prepare(`INSERT INTO maintenance_state (key, value, updated_at)
				VALUES ('last_error', ?, datetime('now'))
				ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
				.bind(errors.join('; ').slice(0, 4096))
			: db.prepare("DELETE FROM maintenance_state WHERE key = 'last_error'"),
	]);
}
