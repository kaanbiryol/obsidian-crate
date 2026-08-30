ALTER TABLE files ADD COLUMN portable_path TEXT;
UPDATE files SET portable_path = lower(path) WHERE portable_path IS NULL;
CREATE UNIQUE INDEX files_portable_path_idx ON files(portable_path);

ALTER TABLE push_subscriptions ADD COLUMN disabled_at TEXT;
ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT;

CREATE TABLE notification_jobs (
	reminder_id TEXT PRIMARY KEY,
	job_token TEXT NOT NULL,
	operation TEXT NOT NULL CHECK (operation IN ('schedule', 'cancel')),
	payload_json TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	available_at INTEGER NOT NULL,
	last_error TEXT,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX notification_jobs_available_at_idx ON notification_jobs(available_at);

CREATE TABLE file_versions (
	storage_key TEXT PRIMARY KEY,
	path TEXT NOT NULL,
	hash TEXT NOT NULL,
	size INTEGER NOT NULL,
	reason TEXT NOT NULL CHECK (reason IN ('replaced', 'deleted')),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	expires_at INTEGER NOT NULL
);

CREATE INDEX file_versions_expires_at_idx ON file_versions(expires_at);
CREATE INDEX file_versions_path_idx ON file_versions(path, created_at DESC);

CREATE TABLE maintenance_state (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
