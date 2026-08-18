CREATE TABLE IF NOT EXISTS changelog (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	path TEXT NOT NULL,
	action TEXT NOT NULL,
	hash TEXT NOT NULL DEFAULT '',
	size INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
	path TEXT PRIMARY KEY,
	hash TEXT NOT NULL DEFAULT '',
	size INTEGER NOT NULL DEFAULT 0,
	modified TEXT NOT NULL DEFAULT (datetime('now')),
	storage_key TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	device_id TEXT,
	device_name TEXT,
	platform TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_reminders (
	reminder_id TEXT PRIMARY KEY,
	content TEXT NOT NULL,
	project TEXT,
	due_datetime TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vapid_keys (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	public_key TEXT NOT NULL,
	private_key TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
	id TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	device_name TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_enrollment_tokens (
	token_hash TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS web_enrollment_tokens (
	token_hash TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
