-- Apply once to schema versions 2-5, as one D1 transaction under the deployment fence.
-- Copy stored portable keys verbatim: SQLite lower() cannot normalize Unicode.
CREATE TABLE files_v6 (
 path TEXT NOT NULL,
 portable_path TEXT PRIMARY KEY,
 hash TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL DEFAULT 0,
 modified TEXT NOT NULL DEFAULT (datetime('now')),
 storage_key TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO files_v6(path, portable_path, hash, size, modified, storage_key)
 SELECT path, portable_path, hash, size, modified, storage_key FROM files;
DROP TABLE files;
ALTER TABLE files_v6 RENAME TO files;
ALTER TABLE object_cleanup_queue ADD COLUMN file_path TEXT;
CREATE TABLE IF NOT EXISTS staged_uploads (
 storage_key TEXT PRIMARY KEY,
 expires_at INTEGER,
 state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting')),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT
) WITHOUT ROWID;
ALTER TABLE staged_uploads ADD COLUMN file_path TEXT;
UPDATE crate_schema SET version = 6 WHERE id = 1 AND version IN (2, 3, 4, 5);
-- Expire any manifest assembled across the change from original-path ordering
-- to portable-key ordering. Existing nonempty vaults need one fresh snapshot.
CREATE TABLE IF NOT EXISTS initial_import (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 token TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('importing', 'complete')),
 generation INTEGER NOT NULL DEFAULT 0,
 snapshot_seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO initial_import(id, token, state, snapshot_seq)
 SELECT 1, 'schema-6-baseline', 'complete', MAX(
   (SELECT COALESCE(MAX(seq), 0) + 1 FROM changelog),
   COALESCE((SELECT snapshot_seq + 1 FROM initial_import WHERE id = 1), 1))
 WHERE EXISTS (SELECT 1 FROM files) OR EXISTS (SELECT 1 FROM changelog)
   OR EXISTS (SELECT 1 FROM file_versions) OR EXISTS (SELECT 1 FROM initial_import)
 ON CONFLICT(id) DO UPDATE SET snapshot_seq = excluded.snapshot_seq;
INSERT INTO sqlite_sequence(name, seq) SELECT 'changelog', snapshot_seq FROM initial_import
 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'changelog');
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT snapshot_seq FROM initial_import))
 WHERE name = 'changelog' AND EXISTS (SELECT 1 FROM initial_import);
