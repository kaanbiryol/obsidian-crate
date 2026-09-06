CREATE TABLE IF NOT EXISTS d1_migrations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_initial.sql');

CREATE TABLE IF NOT EXISTS changelog (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	path TEXT NOT NULL,
	action TEXT NOT NULL,
	revision TEXT,
	hash TEXT NOT NULL DEFAULT '',
	size INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS changelog_created_at_idx ON changelog(created_at);

CREATE TABLE IF NOT EXISTS files (
	path TEXT PRIMARY KEY,
	portable_path TEXT NOT NULL,
	hash TEXT NOT NULL DEFAULT '',
	size INTEGER NOT NULL DEFAULT 0,
	modified TEXT NOT NULL DEFAULT (datetime('now')),
	storage_key TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS files_portable_path_idx ON files(portable_path);

CREATE TABLE IF NOT EXISTS auth_tokens (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	device_id TEXT,
	device_name TEXT,
	platform TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_seen_at TEXT,
	folder_path TEXT,
	scope TEXT NOT NULL DEFAULT 'vault' CHECK (scope IN ('vault', 'reminders')),
	expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS auth_tokens_expires_at_idx ON auth_tokens(expires_at);

CREATE TABLE IF NOT EXISTS scheduled_reminders (
	reminder_id TEXT PRIMARY KEY,
	schedule_token TEXT NOT NULL,
	content TEXT NOT NULL,
	project TEXT,
	due_datetime TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_jobs (
	reminder_id TEXT PRIMARY KEY,
	job_token TEXT NOT NULL,
	operation TEXT NOT NULL CHECK (operation IN ('schedule', 'cancel')),
	payload_json TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	available_at INTEGER NOT NULL,
	last_error TEXT,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS notification_jobs_available_at_idx
	ON notification_jobs(available_at);

CREATE TABLE IF NOT EXISTS vapid_keys (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	public_key TEXT NOT NULL,
	private_key TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
	owner_token_id TEXT,
	folder_path TEXT,
	id TEXT PRIMARY KEY,
	endpoint TEXT NOT NULL,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	device_name TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	disabled_at TEXT,
	last_error TEXT
);

CREATE TABLE IF NOT EXISTS push_enrollment_tokens (
	token_hash TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS push_enrollment_tokens_expires_at_idx ON push_enrollment_tokens(expires_at);

CREATE TABLE IF NOT EXISTS web_enrollment_tokens (
	folder_path TEXT,
	token_hash TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS web_enrollment_tokens_expires_at_idx ON web_enrollment_tokens(expires_at);

CREATE TABLE IF NOT EXISTS object_cleanup_queue (
	storage_key TEXT PRIMARY KEY,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_versions (
	storage_key TEXT PRIMARY KEY,
	path TEXT NOT NULL,
	hash TEXT NOT NULL,
	size INTEGER NOT NULL,
	reason TEXT NOT NULL CHECK (reason IN ('replaced', 'deleted')),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS file_versions_expires_at_idx ON file_versions(expires_at);
CREATE INDEX IF NOT EXISTS file_versions_path_idx ON file_versions(path, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_state (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminder_file_cache (
	folder_path TEXT NOT NULL,
	file_path TEXT NOT NULL,
	file_hash TEXT NOT NULL,
	parser_version INTEGER NOT NULL,
	reminders_json TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (folder_path, file_path)
);

CREATE TABLE IF NOT EXISTS reminder_operations (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reminder_identities (
    reminder_id TEXT PRIMARY KEY,
    created_operation_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_policy (
  enabled INTEGER NOT NULL DEFAULT 1,
 id INTEGER PRIMARY KEY CHECK (id = 1), folder_path TEXT NOT NULL,
 timezone TEXT NOT NULL, all_day_time TEXT, revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_projection_jobs (
 path TEXT PRIMARY KEY, job_token TEXT NOT NULL,
 last_error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reminder_projections (
 reminder_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, file_revision TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminder_projections_path_idx ON reminder_projections(file_path);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx ON push_subscriptions(endpoint);
CREATE TABLE IF NOT EXISTS request_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
