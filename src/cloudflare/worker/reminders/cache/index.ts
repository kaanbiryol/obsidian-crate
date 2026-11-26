import { listStoredMarkdownFileMetadataByPaths, type StoredMarkdownFileMetadata } from '../../sync/markdown-files';
import type { Env } from '../../types';
import { queryRows } from '../../d1/db';
import { loadReminderFileCache } from './load';
import {
	pruneReminderFileCache,
	saveReminderFileCache,
	writeReminderFileCacheEntries,
} from './persist';
import {
	REMINDER_CACHE_PARSER_VERSION,
	type IncrementalReminderIndexResult,
	type ReminderFileCacheEntry,
} from './types';
import { parseReminderCacheEntries, selectReminderIndexWarmBatch } from './warm';
import { getProjectFromPath } from '@/reminders/core/markdownScan';
import { reminderSourceScanKey } from '../source-migration';
import { buildReminderList, compareProjects, type ReminderSourceIssue } from '@/reminders/core/reminder-list';
import { compareCodePoints } from '@/protocol/portable-path';
import type { RemoteReminderRecord } from '../types';

export { REMINDER_CACHE_PARSER_VERSION, saveReminderFileCache };

export async function loadIncrementalReminderIndex(
	env: Env,
	folderPath: string,
	metadata: StoredMarkdownFileMetadata[],
	/** The folder's cache rows, when the caller already started reading them. */
	preloaded?: ReturnType<typeof loadReminderFileCache>,
): Promise<IncrementalReminderIndexResult> {
	let cachedFiles = new Map<string, ReminderFileCacheEntry>();
	let cachedPaths: string[] = [];
	try {
		({ entries: cachedFiles, rowPaths: cachedPaths } = await (preloaded ?? loadReminderFileCache(env.DB, folderPath)));
	} catch {
		// A transient D1 error falls back to reading R2.
	}

	const resolvedFiles = new Map<string, ReminderFileCacheEntry>();
	const staleMetadata: StoredMarkdownFileMetadata[] = [];
	for (const file of metadata) {
		const cached = cachedFiles.get(file.path);
		if (cached?.fileHash === file.hash) {
			resolvedFiles.set(file.path, cached);
		} else {
			staleMetadata.push(file);
		}
	}

	const warmMetadata = selectReminderIndexWarmBatch(staleMetadata);
	const freshEntries = await parseReminderCacheEntries(env, folderPath, warmMetadata);
	for (const entry of freshEntries) {
		resolvedFiles.set(entry.filePath, entry);
	}

	let persistedFileCount = 0;
	try {
		const writeResult = await writeReminderFileCacheEntries(env.DB, folderPath, freshEntries);
		persistedFileCount = writeResult.persistedPaths.length;
		const current = new Set(metadata.map(file => file.path));
		await pruneReminderFileCache(env.DB, folderPath, cachedPaths.filter(path => !current.has(path)));
	} catch {
		if (staleMetadata.length > freshEntries.length) {
			throw new Error('Reminder index cache could not be warmed');
		}
		// A complete response can still use freshly parsed entries when cache maintenance fails.
	}

	const remainingFiles = staleMetadata.length - warmMetadata.length;
	if (remainingFiles > 0) {
		if (persistedFileCount !== freshEntries.length) {
			throw new Error('Reminder index cache could not be warmed');
		}
		return { ready: false, reason: 'warming', remainingFiles };
	}

	const sources = metadata.flatMap(file => {
		const resolved = resolvedFiles.get(file.path);
		return resolved ? [{ path: file.path, project: getProjectFromPath(file.path, folderPath), reminders: resolved.reminders, issue: resolved.issue }] : [];
	});
	return { ready: true, ...buildReminderList(sources) };
}

interface SourceRow { file_path: string; reminder_id: string; occurrences: number; verified: number }

/** The folder's committed copies of these identities, with whether each holding note's
 * sources are verified at its current revision. */
function sourceRowsSql(db: D1Database, folderPath: string, ids: readonly string[]): D1PreparedStatement {
	return db.prepare(`SELECT s.file_path, s.reminder_id, s.occurrences, COALESCE(st.verified, 0) AS verified
    FROM reminder_sources s LEFT JOIN reminder_source_state st ON st.file_path = s.file_path
    WHERE s.reminder_id IN (SELECT value FROM json_each(?)) AND s.file_path >= ? AND s.file_path < ?`)
		.bind(JSON.stringify(ids), `${folderPath}/`, `${folderPath}0`);
}

/**
 * The current list entries of `files` (the stored rows of a delta's paths that still
 * exist) and of every other note sharing a reminder identity with them, read without
 * loading the rest of the folder. Every commit records each note's identities in
 * `reminder_sources`, so the notes whose duplicates appear or resolve with these are
 * found there; a note whose duplicate resolved through another note's change must be
 * among `files`, which is why clients name their conflicting notes. Returns null when
 * the full index must decide: another folder than the notification folder, an
 * unfinished source scan, more unindexed notes than one warming batch, or sources that
 * disagree with the parsed notes.
 */
export async function loadReminderDelta(
	env: Env,
	folderPath: string,
	files: StoredMarkdownFileMetadata[],
	/** Cache rows for `files`, when the caller already started reading them. */
	preloaded?: ReturnType<typeof loadReminderFileCache>,
): Promise<{ files: StoredMarkdownFileMetadata[]; reminders: RemoteReminderRecord[]; issues: ReminderSourceIssue[] } | null> {
	const entries = new Map<string, ReminderFileCacheEntry>();
	const stale: StoredMarkdownFileMetadata[] = [];
	// Cached entries by file hash; the stale notes of all calls together fit one warming batch.
	const resolve = async (notes: StoredMarkdownFileMetadata[], rows: ReturnType<typeof loadReminderFileCache>) => {
		const { entries: cached } = await rows;
		const missing = notes.filter(file => cached.get(file.path)?.fileHash !== file.hash);
		stale.push(...missing);
		if (selectReminderIndexWarmBatch(stale).length < stale.length) return false;
		const fresh = new Map((await parseReminderCacheEntries(env, folderPath, missing)).map(entry => [entry.filePath, entry]));
		try { await writeReminderFileCacheEntries(env.DB, folderPath, [...fresh.values()]); } catch { /* The cache is an optimization. */ }
		for (const file of notes) entries.set(file.path, fresh.get(file.path) ?? cached.get(file.path)!);
		return true;
	};
	const identities = (notes: StoredMarkdownFileMetadata[]) => [...new Set(notes.flatMap(file => entries.get(file.path)!.reminders.map(reminder => reminder.id)))];
	if (!await resolve(files, preloaded ?? loadReminderFileCache(env.DB, folderPath, files.map(file => file.path)))) return null;
	const ids = identities(files);
	// Identities are complete only after the folder's one-time source scan and parser upgrade.
	const [check, first] = await env.DB.batch([env.DB.prepare(`SELECT (SELECT folder_path FROM notification_policy WHERE id = 1) AS folder,
    (SELECT value FROM maintenance_state WHERE key = ?) = ''
      AND NOT EXISTS (SELECT 1 FROM reminder_source_state WHERE parser_version < ? LIMIT 1) AS indexed`)
		.bind(reminderSourceScanKey(folderPath), REMINDER_CACHE_PARSER_VERSION), sourceRowsSql(env.DB, folderPath, ids)]) as [{ results: Array<{ folder: string | null; indexed: number | null }> }, { results: SourceRow[] }];
	const state = check.results[0];
	if (state?.folder !== folderPath || !state.indexed) return null;
	const rows = [...first.results];
	// Unchanged notes that share an identity with these can gain or lose a duplicate.
	const sharing = [...new Set(rows.map(row => row.file_path))].filter(path => !entries.has(path));
	let all = files;
	if (sharing.length) {
		const cache = loadReminderFileCache(env.DB, folderPath, sharing);
		// Its failure is handled where it is awaited.
		cache.catch(() => undefined);
		const shared = await listStoredMarkdownFileMetadataByPaths(env.DB, sharing);
		if (!await resolve(shared, cache)) return null;
		all = [...files, ...shared].sort((left, right) => compareCodePoints(left.path, right.path));
		// Their other identities decide their other reminders; those copies are all unchanged.
		const known = new Set(ids);
		const more = identities(shared).filter(id => !known.has(id));
		if (more.length) rows.push(...await queryRows<SourceRow>(sourceRowsSql(env.DB, folderPath, more)));
	}
	// The full list counts the reminders of notes without an issue. A note keeps its last
	// verified sources while it has an issue; unverified sources of any other note may be stale.
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (entries.get(row.file_path)?.issue) continue;
		if (!row.verified) return null;
		counts.set(row.reminder_id, (counts.get(row.reminder_id) ?? 0) + row.occurrences);
	}
	for (const file of all) {
		const own = new Map<string, number>();
		for (const reminder of entries.get(file.path)!.reminders) own.set(reminder.id, (own.get(reminder.id) ?? 0) + 1);
		// A commit that landed after these notes were read.
		for (const [id, copies] of own) if ((counts.get(id) ?? 0) < copies) return null;
	}
	const { reminders, issues } = buildReminderList(all.map(file => {
		const entry = entries.get(file.path)!;
		return { path: file.path, project: getProjectFromPath(file.path, folderPath), reminders: entry.reminders, issue: entry.issue };
	}), counts);
	return { files: all, reminders, issues };
}

/** Projects of these notes, in list order; one note is one project. */
export function reminderProjects(files: readonly { path: string }[], folderPath: string): string[] {
	return [...new Set(files.map(file => getProjectFromPath(file.path, folderPath)))].sort(compareProjects);
}
