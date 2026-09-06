CREATE TABLE IF NOT EXISTS notification_policy (
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
