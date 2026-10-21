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
import { buildReminderList } from '@/reminders/core/reminder-list';

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
