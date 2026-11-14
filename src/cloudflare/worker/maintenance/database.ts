export async function pruneExpiredTokens(db: D1Database, now = Date.now()): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM auth_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now),
		// Also removes subscriptions a revocation outside the coordinator lock left without an owner.
		db.prepare('DELETE FROM push_subscriptions WHERE NOT EXISTS (SELECT 1 FROM auth_tokens WHERE id = push_subscriptions.owner_token_id)'),
		// Every one-time grant: enrollment links, Reading codes and save links, device and app pairings.
		db.prepare('DELETE FROM grants WHERE expires_at <= ?').bind(now),
	]);
}

export async function recordMaintenanceRun(
	db: D1Database,
	errors: string[] = [],
	timestamp = new Date().toISOString(),
): Promise<void> {
	await db.batch([
		db.prepare(`INSERT INTO maintenance_state (key, value)
			VALUES ('last_run', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.bind(timestamp),
		errors.length > 0
			? db.prepare(`INSERT INTO maintenance_state (key, value)
				VALUES ('last_error', ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
				.bind(errors.join('; ').slice(0, 4096))
			: db.prepare("DELETE FROM maintenance_state WHERE key = 'last_error'"),
	]);
}
