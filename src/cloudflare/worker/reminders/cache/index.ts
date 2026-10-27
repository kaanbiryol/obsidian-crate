import type { StoredMarkdownFileMetadata } from '../../storage';
import type { Env } from '../../types';
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
import { getProjectFromPath } from '../scan';
import { reminderSourceScanKey } from '../source-migration';
import { duplicateReminderSourcesSql } from '../source-identity';
import { buildReminderList, compareProjects } from '@/reminders/core/reminder-list';
import type { RemoteReminderRecord } from '../types';

export { REMINDER_CACHE_PARSER_VERSION, saveReminderFileCache };

export async function loadIncrementalReminderIndex(
	env: Env,
	folderPath: string,
	metadata: StoredMarkdownFileMetadata[],
): Promise<IncrementalReminderIndexResult> {
	let cachedFiles = new Map<string, ReminderFileCacheEntry>();
	let cachedPaths: string[] = [];
	try {
		({ entries: cachedFiles, rowPaths: cachedPaths } = await loadReminderFileCache(env.DB, folderPath));
	} catch {
		// A missing cache table or transient D1 error falls back to reading R2.
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

/**
 * The changed notes of a delta whose base was complete and issue-free, read without
 * loading the rest of the folder. Every commit records each note's reminder identities
 * in `reminder_sources`, so a new duplicate with an unchanged note is found there.
 * Returns null when the full index must decide: another folder than the notification
 * folder, more unindexed notes than one warming batch, a source issue or a duplicate.
 */
export async function loadReminderDelta(
	env: Env,
	folderPath: string,
	metadata: StoredMarkdownFileMetadata[],
	changedPaths: readonly string[],
): Promise<{ reminders: RemoteReminderRecord[]; projects: string[] } | null> {
	const changed = new Set(changedPaths);
	const files = metadata.filter(file => changed.has(file.path));
	const { entries: cached } = await loadReminderFileCache(env.DB, folderPath, files.map(file => file.path));
	const stale = files.filter(file => cached.get(file.path)?.fileHash !== file.hash);
	if (selectReminderIndexWarmBatch(stale).length < stale.length) return null;
	const fresh = new Map((await parseReminderCacheEntries(env, folderPath, stale)).map(entry => [entry.filePath, entry]));
	try { await writeReminderFileCacheEntries(env.DB, folderPath, [...fresh.values()]); } catch { /* The cache is an optimization. */ }
	const resolved = files.map(file => fresh.get(file.path) ?? cached.get(file.path)!);
	if (resolved.some(entry => entry.issue)) return null;
	const reminders = resolved.flatMap(entry => entry.reminders);
	// Identities are complete only after the folder's one-time source scan and parser upgrade.
	const duplicate = duplicateReminderSourcesSql(folderPath, [...new Set(reminders.map(reminder => reminder.id))]);
	const check = await env.DB.prepare(`SELECT (SELECT folder_path FROM notification_policy WHERE id = 1) AS folder,
    (SELECT value FROM maintenance_state WHERE key = ?) = ''
      AND NOT EXISTS (SELECT 1 FROM reminder_source_state WHERE parser_version < ? LIMIT 1) AS indexed,
    ${duplicate.sql} AS duplicate`)
		.bind(reminderSourceScanKey(folderPath), REMINDER_CACHE_PARSER_VERSION, ...duplicate.args)
		.first<{ folder: string | null; indexed: number | null; duplicate: number }>();
	if (check?.folder !== folderPath || !check.indexed || check.duplicate) return null;
	return { reminders, projects: [...new Set(metadata.map(file => getProjectFromPath(file.path, folderPath)))].sort(compareProjects) };
}
