import { findReferencedStorageKeys } from '../storage-references';

const MANAGED_FILES_PREFIX = '__crate__/files/';
const ORPHAN_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_SWEEP_LIMIT = 100;
const CURSOR_KEY = 'orphan_sweep_cursor';
export const LEGACY_SWEEP_CUTOFF_KEY = 'legacy_orphan_sweep_cutoff';
export const LEGACY_SWEEP_DONE_KEY = 'legacy_orphan_sweep_done';

async function loadCursor(db: D1Database): Promise<string | undefined> {
	const row = await db.prepare("SELECT value FROM maintenance_state WHERE key = 'orphan_sweep_cursor'")
		.first<{ value: string }>();
	return row?.value || undefined;
}

async function saveCursor(db: D1Database, cursor: string | undefined): Promise<void> {
	if (!cursor) {
		await db.prepare("DELETE FROM maintenance_state WHERE key = 'orphan_sweep_cursor'").run();
		return;
	}
	await db.prepare(`INSERT INTO maintenance_state (key, value, updated_at)
		VALUES (?, ?, datetime('now'))
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
		.bind(CURSOR_KEY, cursor)
		.run();
}

export async function sweepOrphanedManagedObjects(
	bucket: R2Bucket,
	db: D1Database,
	now = Date.now(),
): Promise<number> {
  if (await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(LEGACY_SWEEP_DONE_KEY).first()) return 0;
  const cutoff = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(LEGACY_SWEEP_CUTOFF_KEY).first<{ value: string }>();
  if (!cutoff) {
    await db.prepare('INSERT OR IGNORE INTO maintenance_state(key, value) VALUES (?, ?)').bind(LEGACY_SWEEP_CUTOFF_KEY, String(now)).run();
    return 0;
  }
  if (now < Number(cutoff.value) + ORPHAN_MINIMUM_AGE_MS) return 0;
	const cursor = await loadCursor(db);
	const listed = await bucket.list({
		prefix: MANAGED_FILES_PREFIX,
		limit: ORPHAN_SWEEP_LIMIT,
		...(cursor ? { cursor } : {}),
	});
	let candidates = listed.objects
		.filter(object => object.uploaded.getTime() <= Number(cutoff.value) && now - object.uploaded.getTime() >= ORPHAN_MINIMUM_AGE_MS)
		.map(object => object.key);
  if (candidates.length) {
    const tracked = await db.prepare('SELECT storage_key FROM staged_uploads WHERE storage_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(candidates)).all<{ storage_key: string }>();
    const keys = new Set(tracked.results.map(row => row.storage_key));
    candidates = candidates.filter(key => !keys.has(key));
  }
	let deleted = 0;
	if (candidates.length > 0) {
		const referencedKeys = await findReferencedStorageKeys(db, candidates);
		const orphaned = candidates.filter(key => !referencedKeys.has(key));
		if (orphaned.length > 0) {
			await bucket.delete(orphaned.length === 1 ? orphaned[0]! : orphaned);
			deleted = orphaned.length;
		}
	}

	await saveCursor(db, listed.truncated ? listed.cursor : undefined);
  if (!listed.truncated) await db.prepare('INSERT OR IGNORE INTO maintenance_state(key, value) VALUES (?, ?)').bind(LEGACY_SWEEP_DONE_KEY, String(now)).run();
	return deleted;
}
