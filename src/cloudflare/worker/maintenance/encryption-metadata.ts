import { ENCRYPTION_FILE_PREFIX, ENCRYPTION_STATE_KEY } from '../encryption-state';

const CURSOR_KEY = 'e2ee:descriptor-cleanup-cursor';
const PAGE_SIZE = 100;

/** Descriptors follow their immutable revision's lifetime, including receipts.
 * Check references in the deletion statement so concurrent publication wins.
 * Checkpoints can download only revisions still in files or file_versions. */
export async function pruneEncryptionMetadata(db: D1Database): Promise<void> {
	const cursor = (await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(CURSOR_KEY).first<{ value: string }>())?.value ?? ENCRYPTION_FILE_PREFIX;
	const page = await db.prepare('SELECT key FROM maintenance_state WHERE key > ? AND key >= ? AND key < ? ORDER BY key LIMIT ?')
		.bind(cursor, ENCRYPTION_FILE_PREFIX, 'e2ee:file;', PAGE_SIZE).all<{ key: string }>();
	await db.batch([
		db.prepare(`WITH candidates(key, revision) AS (SELECT value, substr(value, ?) FROM json_each(?)),
			batch_keys(revision) AS (SELECT CASE WHEN k.type = 'text' THEN k.value ELSE json_extract(k.value, '$.storageKey') END
				FROM staged_upload_batches b, json_each(b.storage_keys) k)
		DELETE FROM maintenance_state WHERE key IN (SELECT key FROM candidates WHERE
			revision NOT IN (SELECT storage_key FROM files)
			AND revision NOT IN (SELECT storage_key FROM file_versions)
			AND revision NOT IN (SELECT revision FROM changelog WHERE revision IS NOT NULL)
			AND revision NOT IN (SELECT consumed_revision FROM file_deletion_receipts)
			AND revision NOT IN (SELECT json_extract(response_json, '$.revision') FROM upload_operations WHERE json_type(response_json, '$.revision') = 'text')
			AND revision NOT IN (SELECT storage_key FROM staged_uploads)
			AND revision NOT IN (SELECT revision FROM batch_keys WHERE revision IS NOT NULL))
			AND updated_at < datetime('now', '-1 day')
			AND EXISTS (SELECT 1 FROM maintenance_state WHERE key = ? AND json_extract(value, '$.mode') = 'active')`)
			.bind(ENCRYPTION_FILE_PREFIX.length + 1, JSON.stringify(page.results.map(row => row.key)), ENCRYPTION_STATE_KEY),
		page.results.length === PAGE_SIZE
			? db.prepare("INSERT INTO maintenance_state(key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
				.bind(CURSOR_KEY, page.results.at(-1)!.key)
			: db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(CURSOR_KEY),
	]);
}
