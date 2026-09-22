ALTER TABLE auth_tokens RENAME TO auth_tokens_v1;
DROP INDEX auth_tokens_expires_at_idx;
CREATE TABLE IF NOT EXISTS auth_tokens (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	device_id TEXT,
	device_name TEXT,
	platform TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	last_seen_at TEXT,
	folder_path TEXT,
	scope TEXT NOT NULL DEFAULT 'vault' CHECK (scope IN ('vault', 'reminders', 'reading', 'reading_capture')),
	expires_at INTEGER,
 reading_generation TEXT
);

CREATE INDEX IF NOT EXISTS auth_tokens_expires_at_idx ON auth_tokens(expires_at);

INSERT INTO auth_tokens (id, token_hash, device_id, device_name, platform, created_at, last_seen_at, folder_path, scope, expires_at)
 SELECT id, token_hash, device_id, device_name, platform, created_at, last_seen_at, folder_path, scope, expires_at FROM auth_tokens_v1;
DROP TABLE auth_tokens_v1;
CREATE TABLE IF NOT EXISTS reading_policy (
 id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL,
 folder_path TEXT NOT NULL, generation TEXT NOT NULL, revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reading_sources (
 path TEXT PRIMARY KEY, revision TEXT NOT NULL, generation TEXT NOT NULL,
 item_id TEXT, url_identity TEXT, metadata_json TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS reading_sources_id_idx ON reading_sources(item_id);
CREATE INDEX IF NOT EXISTS reading_sources_url_idx ON reading_sources(url_identity);
CREATE TABLE IF NOT EXISTS reading_jobs (
 path TEXT PRIMARY KEY, item_id TEXT NOT NULL, generation TEXT NOT NULL,
 source_revision TEXT NOT NULL, block_hash TEXT NOT NULL, url TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reading_jobs_due_idx ON reading_jobs(available_at);
CREATE TABLE IF NOT EXISTS reading_operations (
 operation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, generation TEXT NOT NULL,
 request_hash TEXT NOT NULL, response_json TEXT NOT NULL, day INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reading_operations_day_idx ON reading_operations(day);
CREATE TABLE IF NOT EXISTS reading_enrollments (
 token_hash TEXT PRIMARY KEY, generation TEXT NOT NULL, scope TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reading_handoffs (
 token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL, generation TEXT NOT NULL,
 body TEXT NOT NULL, expires_at INTEGER NOT NULL
);
