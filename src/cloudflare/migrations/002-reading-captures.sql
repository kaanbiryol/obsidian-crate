CREATE TABLE IF NOT EXISTS reading_captures (
 id TEXT PRIMARY KEY, generation TEXT NOT NULL, url_identity TEXT NOT NULL,
 note TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
 UNIQUE(generation, url_identity)
);
CREATE INDEX IF NOT EXISTS reading_captures_due_idx ON reading_captures(available_at);
