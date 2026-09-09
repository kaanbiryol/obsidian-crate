CREATE TABLE IF NOT EXISTS crate_schema (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 version INTEGER NOT NULL
);
INSERT OR IGNORE INTO crate_schema (id, version) VALUES (1, 5);

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
CREATE INDEX IF NOT EXISTS files_markdown_path_idx ON files(path) WHERE lower(path) LIKE '%.md';

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
	delivery_failed_at TEXT,
	delivery_error TEXT,
	delivery_attempts INTEGER,
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
	owner_token_id TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS reminder_operations_created_at_idx ON reminder_operations(created_at);

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
 notification_token TEXT, policy_revision TEXT,
 reminder_id TEXT PRIMARY KEY, file_path TEXT NOT NULL, file_revision TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminder_projections_path_idx ON reminder_projections(file_path);

CREATE TABLE IF NOT EXISTS reminder_sources (
 file_path TEXT NOT NULL, reminder_id TEXT NOT NULL, due_key TEXT NOT NULL,
 occurrences INTEGER NOT NULL,
 PRIMARY KEY (file_path, reminder_id)
);
CREATE INDEX IF NOT EXISTS reminder_sources_id_idx ON reminder_sources(reminder_id);
CREATE TABLE IF NOT EXISTS reminder_source_state (
 file_path TEXT PRIMARY KEY, file_revision TEXT NOT NULL,
 parser_version INTEGER NOT NULL, verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS reminder_source_state_version_idx ON reminder_source_state(parser_version, file_path);
CREATE INDEX IF NOT EXISTS reminder_source_state_retry_idx ON reminder_source_state(updated_at, file_path) WHERE verified = 0;
CREATE TABLE IF NOT EXISTS reminder_occurrences (
 reminder_id TEXT NOT NULL, due_key TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
 PRIMARY KEY (reminder_id, due_key)
);
CREATE INDEX IF NOT EXISTS reminder_occurrences_first_seen_idx ON reminder_occurrences(first_seen_at);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx ON push_subscriptions(endpoint);
CREATE TABLE IF NOT EXISTS request_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS file_deletion_receipts (
 consumed_revision TEXT PRIMARY KEY,
 revision TEXT NOT NULL UNIQUE,
 changelog_seq INTEGER NOT NULL UNIQUE,
 path TEXT NOT NULL,
 consumed_hash TEXT NOT NULL,
 request_id TEXT NOT NULL,
 device_id TEXT,
 client_session TEXT,
 operation_id TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS file_deletion_receipts_created_at_idx ON file_deletion_receipts(created_at);

UPDATE crate_schema SET version = 4 WHERE id = 1 AND version IN (2, 3);

CREATE INDEX IF NOT EXISTS files_storage_key_idx ON files(storage_key);

CREATE TABLE IF NOT EXISTS upload_operations (
 operation_id TEXT PRIMARY KEY,
 request_hash TEXT NOT NULL,
 response_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
UPDATE crate_schema SET version = 5 WHERE id = 1 AND version IN (2, 3, 4);
