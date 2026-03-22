let dbReady = false;

export async function initDb(db: D1Database): Promise<void> {
	if (dbReady) return;
	await db.prepare(`CREATE TABLE IF NOT EXISTS changelog (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		path TEXT NOT NULL,
		action TEXT NOT NULL,
		hash TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	await db.prepare(`CREATE TABLE IF NOT EXISTS files (
		path TEXT PRIMARY KEY,
		hash TEXT NOT NULL DEFAULT '',
		size INTEGER NOT NULL DEFAULT 0,
		modified TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	await db.prepare(`CREATE TABLE IF NOT EXISTS auth_tokens (
		id TEXT PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		device_name TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	await db.prepare(`CREATE TABLE IF NOT EXISTS scheduled_reminders (
		reminder_id TEXT PRIMARY KEY,
		content TEXT NOT NULL,
		project TEXT,
		due_datetime TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	await db.prepare(`CREATE TABLE IF NOT EXISTS vapid_keys (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		public_key TEXT NOT NULL,
		private_key TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	await db.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
		id TEXT PRIMARY KEY,
		endpoint TEXT NOT NULL,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		device_name TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	dbReady = true;
}

const CHANGELOG_RETENTION_DAYS = 30;

export async function maybePruneChangelog(db: D1Database): Promise<void> {
	if (Math.random() > 0.05) return;
	try {
		await db.prepare(
			"DELETE FROM changelog WHERE created_at < datetime('now', '-' || ? || ' days')"
		).bind(CHANGELOG_RETENTION_DAYS).run();
	} catch { /* non-fatal */ }
}

export async function queryRows<T = Record<string, unknown>>(statement: D1PreparedStatement): Promise<T[]> {
	const result = await statement.all();
	return (Array.isArray(result?.results) ? result.results : []) as T[];
}
