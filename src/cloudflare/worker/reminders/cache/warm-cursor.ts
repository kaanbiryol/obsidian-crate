import { putMaintenanceValue, queryRows } from '../../d1/db';
import { FILE_FOLDER_MATCH, fileFolderArgs } from '../../sync/file-identity';
import type { Env } from '../../types';
import { isReminderNotePath } from '../../../../protocol/reminder-archive-path';
import { writeReminderFileCacheEntries } from './persist';
import { REMINDER_CACHE_PARSER_VERSION, REMINDER_INDEX_WARM_MAX_FILES } from './types';
import { parseReminderCacheEntries, selectReminderIndexWarmBatch } from './warm';

/**
 * A cold folder warms its reminder cache over many requests. The first lists the whole
 * folder and saves this cursor; each later request reads only the next unindexed notes
 * after it, so warming reads each note about once instead of the whole folder per batch.
 * With one batch or less left the cursor is cleared, and the next request lists the
 * folder in full, which indexes the rest, catches notes changed behind the cursor and
 * answers.
 */
interface ReminderWarmCursor {
	/** The portable path of the last note this warming has passed. */
	after: string;
	/** Progress shown to the app, counted down from the full listing that started warming. */
	remaining: number;
	total: number;
}

const cursorKey = (folderPath: string) => `reminder_index_warm_v${REMINDER_CACHE_PARSER_VERSION}:${folderPath}`;

export async function readReminderWarmCursor(db: D1Database, folderPath: string): Promise<ReminderWarmCursor | null> {
	const row = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(cursorKey(folderPath)).first<{ value: string }>();
	if (!row) return null;
	try {
		const value = JSON.parse(row.value) as Partial<ReminderWarmCursor>;
		if (typeof value.after === 'string' && typeof value.remaining === 'number' && typeof value.total === 'number') return value as ReminderWarmCursor;
	} catch { /* An unreadable cursor restarts from a full listing. */ }
	await clearReminderWarmCursor(db, folderPath);
	return null;
}

export async function saveReminderWarmCursor(db: D1Database, folderPath: string, cursor: ReminderWarmCursor): Promise<void> {
	await putMaintenanceValue(db, cursorKey(folderPath), JSON.stringify(cursor)).run();
}

async function clearReminderWarmCursor(db: D1Database, folderPath: string): Promise<void> {
	await db.prepare('DELETE FROM maintenance_state WHERE key = ?').bind(cursorKey(folderPath)).run();
}

/** Indexes the next batch of notes after the cursor and returns the progress to show. */
export async function continueReminderIndexWarm(env: Env, folderPath: string, cursor: ReminderWarmCursor): Promise<{ remainingFiles: number; totalFiles: number }> {
	// Notes without a current cache row, in key order from the cursor: the scan stops after
	// one batch, so it reads about as many rows as it returns. One more row shows whether
	// this batch is the last.
	const found = await queryRows<{ path: string; portable_path: string; hash: string; size: number; storage_key: string }>(env.DB.prepare(
		`SELECT f.path, f.portable_path, f.hash, f.size, f.storage_key FROM files f
		LEFT JOIN reminder_file_cache c ON c.folder_path = ? AND c.file_path = f.path AND c.parser_version = ?
		WHERE f.portable_path > ? AND ${FILE_FOLDER_MATCH} AND lower(f.path) LIKE '%.md'
			AND (c.file_hash IS NULL OR c.file_hash <> f.hash)
		ORDER BY f.portable_path LIMIT ?`,
	).bind(folderPath, REMINDER_CACHE_PARSER_VERSION, cursor.after, ...fileFolderArgs(folderPath), REMINDER_INDEX_WARM_MAX_FILES + 1));
	const last = found.length <= REMINDER_INDEX_WARM_MAX_FILES;
	const rows = found.slice(0, REMINDER_INDEX_WARM_MAX_FILES);
	const notes = rows.filter(row => isReminderNotePath(row.path, folderPath))
		.map(row => ({ path: row.path, portable: row.portable_path, hash: row.hash, size: row.size, storageKey: row.storage_key }));
	const batch = selectReminderIndexWarmBatch(notes) as typeof notes;
	const fresh = await parseReminderCacheEntries(env, folderPath, batch);
	const { persistedPaths } = await writeReminderFileCacheEntries(env.DB, folderPath, fresh);
	if (persistedPaths.length !== fresh.length) throw new Error('Reminder index cache could not be warmed');
	const remaining = cursor.remaining - batch.length;
	// A batch cut short by its byte budget resumes after its last note.
	const after = batch.length < notes.length ? batch.at(-1)!.portable : rows.at(-1)?.portable_path;
	// With one batch or less left, the next full listing indexes it and answers.
	if ((last && batch.length === notes.length) || remaining <= REMINDER_INDEX_WARM_MAX_FILES) await clearReminderWarmCursor(env.DB, folderPath);
	else await saveReminderWarmCursor(env.DB, folderPath, { after: after!, remaining, total: cursor.total });
	return { remainingFiles: Math.max(1, remaining), totalFiles: cursor.total };
}
