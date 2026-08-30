import { queryRows } from '../db';

const MANAGED_FILES_PREFIX = '__crate__/files/';
const ORPHAN_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_SWEEP_LIMIT = 100;
const CURSOR_KEY = 'orphan_sweep_cursor';

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
	const cursor = await loadCursor(db);
	const listed = await bucket.list({
		prefix: MANAGED_FILES_PREFIX,
		limit: ORPHAN_SWEEP_LIMIT,
		...(cursor ? { cursor } : {}),
	});
	const candidates = listed.objects
		.filter(object => now - object.uploaded.getTime() >= ORPHAN_MINIMUM_AGE_MS)
		.map(object => object.key);
	let deleted = 0;
	if (candidates.length > 0) {
		const placeholders = candidates.map(() => '?').join(', ');
		const referenced = await queryRows<{ storage_key: string }>(db.prepare(`
			SELECT storage_key FROM files WHERE storage_key IN (${placeholders})
			UNION SELECT storage_key FROM file_versions WHERE storage_key IN (${placeholders})
		`).bind(...candidates, ...candidates));
		const referencedKeys = new Set(referenced.map(row => row.storage_key));
		const orphaned = candidates.filter(key => !referencedKeys.has(key));
		if (orphaned.length > 0) {
			await bucket.delete(orphaned.length === 1 ? orphaned[0]! : orphaned);
			deleted = orphaned.length;
		}
	}

	await saveCursor(db, listed.truncated ? listed.cursor : undefined);
	return deleted;
}
