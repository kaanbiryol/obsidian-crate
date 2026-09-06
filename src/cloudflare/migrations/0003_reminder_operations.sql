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
