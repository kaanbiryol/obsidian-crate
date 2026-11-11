import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from '../sync/file-identity';
import { portablePathKey } from '../../../protocol/portable-path';
import { REMINDER_CACHE_PARSER_VERSION } from './cache/types';

/** This durable authority is separate from the disposable, folder-specific UI cache.
 * `sourcesDigest` names the verified sources summary, so an unchanged one can skip
 * rewriting them. Setting an indexed column rewrites its index entry even when the
 * value is unchanged, so `parser_version` changes in its own statement, only when it differs. */
export function recordReminderSourceState(db: D1Database, path: string, storageKey: string | null, verified: boolean, sourcesDigest: string | null = null): D1PreparedStatement[] {
	if (storageKey === null) return [db.prepare(`DELETE FROM reminder_source_state WHERE file_path = ?
    AND NOT EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH})`).bind(path, ...filePathArgs(path))];
	const revision = fileRevisionGuard(path, storageKey);
	return [db.prepare(`INSERT INTO reminder_source_state (file_path, file_revision, parser_version, verified, sources_digest)
    SELECT ?, ?, ?, ?, ? WHERE ${revision.sql}
    ON CONFLICT(file_path) DO UPDATE SET file_revision = excluded.file_revision,
      verified = excluded.verified, sources_digest = excluded.sources_digest`)
		.bind(path, storageKey, REMINDER_CACHE_PARSER_VERSION, verified ? 1 : 0, verified ? sourcesDigest : null, ...revision.args),
	db.prepare(`UPDATE reminder_source_state SET parser_version = ? WHERE file_path = ? AND parser_version != ? AND ${revision.sql}`)
		.bind(REMINDER_CACHE_PARSER_VERSION, path, REMINDER_CACHE_PARSER_VERSION, ...revision.args)];
}

/** True, as SQL, unless the file's state already records `sourcesDigest` as verified by
 * this parser. Place it before `recordReminderSourceState` in the batch. */
export function sourcesChangedSql(path: string, sourcesDigest: string): { sql: string; args: unknown[] } {
	return { sql: `NOT EXISTS (SELECT 1 FROM reminder_source_state WHERE file_path = ? AND sources_digest = ?
    AND verified = 1 AND parser_version = ?)`, args: [path, sourcesDigest, REMINDER_CACHE_PARSER_VERSION] };
}

/** Scheduled deliveries need current source and projection authority. Every commit that
 * records a verified source revision also queues that file's projection job, and a
 * projection removes the job only with its own writes. So a verified current revision
 * without a job proves the reminder's row was projected from that revision. Returns the
 * IDs whose row still has the given token and that authority. */
export async function notificationAuthority(db: D1Database, rows: ReadonlyArray<{ id: string; token: string; filePath: string }>): Promise<Set<string>> {
	if (!rows.length) return new Set();
	const keyed = rows.map(row => ({ id: row.id, token: row.token, portable: portablePathKey(row.filePath) }));
	const authorized = await db.prepare(`SELECT p.reminder_id AS id FROM json_each(?) r
    JOIN reminder_projections p ON p.reminder_id = json_extract(r.value, '$.id') AND p.notification_token = json_extract(r.value, '$.token')
    JOIN files f ON f.portable_path = json_extract(r.value, '$.portable') AND f.path = p.file_path
    JOIN reminder_source_state source ON source.file_path = p.file_path AND source.file_revision = f.storage_key
    JOIN notification_policy policy ON policy.id = 1 AND policy.enabled = 1
    WHERE source.parser_version = ? AND source.verified = 1
      AND NOT EXISTS (SELECT 1 FROM notification_projection_jobs WHERE path = p.file_path)`)
		.bind(JSON.stringify(keyed), REMINDER_CACHE_PARSER_VERSION).all<{ id: string }>();
	return new Set(authorized.results.map(row => row.id));
}
