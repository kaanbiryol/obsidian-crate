import { ENCRYPTION_FILE_PREFIX, ENCRYPTION_STATE_SQL } from '../encryption/state';
import { changedRows, type SqlGuard } from '../db';

const CURSOR_KEY = 'e2ee:descriptor-cleanup-cursor';
// A cursor with this prefix found unused descriptors, so later passes continue.
const RESUME = '+';
const DESCRIPTOR_KEYS_END = 'e2ee:file;';
// Each page reads the live file table once, so a larger page sweeps more descriptors
// for the same scan cost.
export const DESCRIPTOR_CLEANUP_PAGE = 5000;

const ACTIVE = `json_extract(${ENCRYPTION_STATE_SQL}, '$.mode') = 'active'`;
const descriptorKey = (revision: string) => `'${ENCRYPTION_FILE_PREFIX}' || ${revision}`;
/** Deletion receipts and upload leases that still need a revision's descriptor.
 * Upload receipts are not references: a replayed receipt returns its stored
 * response, and clients never open the descriptor of a receipt's revision. */
const held = (revision: string) => `(EXISTS (SELECT 1 FROM file_deletion_receipts WHERE consumed_revision = ${revision})
	OR EXISTS (SELECT 1 FROM staged_uploads WHERE storage_key = ${revision})
	OR ${revision} IN (SELECT staged FROM (SELECT CASE WHEN k.type = 'text' THEN k.value ELSE json_extract(k.value, '$.storageKey') END AS staged
		FROM staged_upload_batches b, json_each(b.storage_keys) k) WHERE staged IS NOT NULL))`;
/** A revision's changelog entry is written in the same transaction as its descriptor,
 * and pruning keeps the changelog contiguous from its oldest entry. Once that entry is
 * newer than the descriptor, the revision has no changelog entry left. */
const CHANGELOG_PRUNED = `NOT EXISTS (SELECT 1 FROM changelog WHERE created_at <= datetime(maintenance_state.updated_at, '+1 minute'))`;

/** Runs in the changelog pruning transaction: drops descriptors whose last
 * reference is one of the `expired` changelog entries (sequence numbers). */
export function releasePrunedChangelogDescriptors(db: D1Database, expired: SqlGuard<unknown>): D1PreparedStatement {
	return db.prepare(`DELETE FROM maintenance_state WHERE ${ACTIVE} AND key IN (SELECT ${descriptorKey('c.revision')} FROM changelog c
		WHERE c.seq IN (${expired.sql}) AND c.action = 'put' AND c.revision IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM files WHERE portable_path = lower(c.path) AND storage_key = c.revision)
		AND NOT EXISTS (SELECT 1 FROM file_versions WHERE storage_key = c.revision)
		AND NOT ${held('c.revision')})`).bind(...expired.args);
}

/** Runs in the version expiry transaction: drops descriptors whose last reference
 * is one of the `expired` retained versions (storage keys). Encrypted paths are
 * lowercase tags, so a path is its own portable key. */
export function releaseExpiredVersionDescriptors(db: D1Database, expired: SqlGuard<unknown>): D1PreparedStatement {
	return db.prepare(`DELETE FROM maintenance_state WHERE ${ACTIVE} AND key IN (SELECT ${descriptorKey('v.storage_key')} FROM file_versions v
		WHERE v.storage_key IN (${expired.sql})
		AND NOT EXISTS (SELECT 1 FROM files WHERE portable_path = lower(v.path) AND storage_key = v.storage_key)
		AND NOT ${held('v.storage_key')}) AND ${CHANGELOG_PRUNED}`).bind(...expired.args);
}

/** Bounded fallback for descriptors no release removed, such as those that only
 * upload receipts kept before receipts stopped counting. Each pass checks one page of
 * descriptor keys; later passes of an episode continue while pages find unused ones.
 * References are checked in the deletion statement, so concurrent publication wins.
 * Returns true when more unused descriptors may remain. */
export async function pruneEncryptionMetadata(db: D1Database, firstPass: boolean): Promise<boolean> {
	const page = await db.prepare(`WITH cursor AS (SELECT value FROM maintenance_state WHERE key = ?)
		SELECT (SELECT value FROM cursor) AS cursor, (SELECT key FROM maintenance_state
			WHERE key > COALESCE((SELECT ltrim(value, ?) FROM cursor), ?) AND key < ? ORDER BY key LIMIT 1 OFFSET ?) AS last`)
		.bind(CURSOR_KEY, RESUME, ENCRYPTION_FILE_PREFIX, DESCRIPTOR_KEYS_END, DESCRIPTOR_CLEANUP_PAGE - 1)
		.first<{ cursor: string | null; last: string | null }>();
	const cursor = page?.cursor ?? null;
	if (!firstPass && !cursor?.startsWith(RESUME)) return false;
	const after = cursor === null ? ENCRYPTION_FILE_PREFIX : cursor.startsWith(RESUME) ? cursor.slice(RESUME.length) : cursor;
	// Without a last key, the rest of the descriptors fit in this page.
	const last = page?.last ?? null;
	const revision = `substr(maintenance_state.key, ${ENCRYPTION_FILE_PREFIX.length + 1})`;
	const removed = changedRows(await db.prepare(`DELETE FROM maintenance_state WHERE key > ? AND key <= COALESCE(?, key) AND key < ?
		AND updated_at < datetime('now', '-1 day') AND ${ACTIVE} AND ${CHANGELOG_PRUNED}
		AND NOT EXISTS (SELECT 1 FROM file_versions WHERE storage_key = ${revision})
		AND NOT ${held(revision)}
		AND ${revision} NOT IN (SELECT storage_key FROM files)`).bind(after, last, DESCRIPTOR_KEYS_END).run());
	await (last === null
		? db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(CURSOR_KEY)
		: db.prepare("INSERT INTO maintenance_state(key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
			.bind(CURSOR_KEY, `${removed > 0 ? RESUME : ''}${last}`)).run();
	return last !== null && removed > 0;
}
