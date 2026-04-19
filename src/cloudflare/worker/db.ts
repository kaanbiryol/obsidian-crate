const initializedDatabases = new WeakSet<D1Database>();

async function hasColumn(db: D1Database, tableName: string, columnName: string): Promise<boolean> {
	const rows = await queryRows<{ name?: string }>(db.prepare(`PRAGMA table_info(${tableName})`));
	return rows.some((row) => row.name === columnName);
}

export async function initDb(db: D1Database): Promise<void> {
	if (initializedDatabases.has(db)) {
		return;
	}

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
		modified TEXT NOT NULL DEFAULT (datetime('now')),
		storage_key TEXT
	)`).run();
	if (!await hasColumn(db, 'files', 'storage_key')) {
		try {
			await db.prepare('ALTER TABLE files ADD COLUMN storage_key TEXT').run();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
			if (!message.includes('duplicate column') && !message.includes('already exists')) {
				throw error;
			}
		}
	}
	await db.prepare(`CREATE TABLE IF NOT EXISTS auth_tokens (
		id TEXT PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		device_id TEXT,
		device_name TEXT,
		platform TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		last_seen_at TEXT
	)`).run();
	if (!await hasColumn(db, 'auth_tokens', 'device_id')) {
		try {
			await db.prepare('ALTER TABLE auth_tokens ADD COLUMN device_id TEXT').run();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
			if (!message.includes('duplicate column') && !message.includes('already exists')) {
				throw error;
			}
		}
	}
	if (!await hasColumn(db, 'auth_tokens', 'platform')) {
		try {
			await db.prepare('ALTER TABLE auth_tokens ADD COLUMN platform TEXT').run();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
			if (!message.includes('duplicate column') && !message.includes('already exists')) {
				throw error;
			}
		}
	}
	if (!await hasColumn(db, 'auth_tokens', 'last_seen_at')) {
		try {
			await db.prepare('ALTER TABLE auth_tokens ADD COLUMN last_seen_at TEXT').run();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
			if (!message.includes('duplicate column') && !message.includes('already exists')) {
				throw error;
			}
		}
	}
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
	await db.prepare(`CREATE TABLE IF NOT EXISTS push_enrollment_tokens (
		token_hash TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`).run();
	initializedDatabases.add(db);
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
