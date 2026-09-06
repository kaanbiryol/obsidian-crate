import type { StoredMarkdownFileMetadata } from '../storage';
import type { Env } from '../types';
import { loadReminderFileCache } from './reminder-cache/load';
import {
	pruneReminderFileCache,
	saveReminderFileCache,
	writeReminderFileCacheEntries,
} from './reminder-cache/persist';
import {
	REMINDER_CACHE_PARSER_VERSION,
	REMINDER_INDEX_MAX_FILE_BYTES,
	type IncrementalReminderIndexResult,
	type ReminderFileCacheEntry,
} from './reminder-cache/types';
import { parseReminderCacheEntries, selectReminderIndexWarmBatch } from './reminder-cache/warm';
import { getProjectFromPath } from './scan';
import type { RemoteReminderRecord } from './types';
import { ReminderIdentityConflictError } from '../reminder-source-identity';

export { REMINDER_CACHE_PARSER_VERSION, REMINDER_INDEX_MAX_FILE_BYTES, saveReminderFileCache };

export async function loadIncrementalReminderIndex(
	env: Env,
	folderPath: string,
	metadata: StoredMarkdownFileMetadata[],
): Promise<IncrementalReminderIndexResult> {
	let cachedFiles = new Map<string, ReminderFileCacheEntry>();
	try {
		cachedFiles = await loadReminderFileCache(env.DB, folderPath);
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
		await pruneReminderFileCache(env.DB, folderPath);
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

	const reminders: RemoteReminderRecord[] = [];
	const projects = new Set<string>();
	for (const file of metadata) {
		const resolved = resolvedFiles.get(file.path);
		if (!resolved) continue;
		projects.add(getProjectFromPath(file.path, folderPath));
		reminders.push(...resolved.reminders);
	}

	const counts = new Map<string, number>();
	for (const reminder of reminders) counts.set(reminder.id, (counts.get(reminder.id) ?? 0) + 1);
	const duplicateFiles = new Set(reminders.filter(reminder => counts.get(reminder.id)! > 1).map(reminder => reminder.filePath));
	return {
		ready: true,
		issues: [...resolvedFiles.values()].flatMap(file => {
      const reason = file.issue ?? (duplicateFiles.has(file.filePath) ? new ReminderIdentityConflictError().message : undefined);
      return reason ? [{ path: file.filePath, reason }] : [];
    }),
		reminders: reminders.filter(reminder => counts.get(reminder.id) === 1),
		projects: Array.from(projects).sort((left, right) => left.localeCompare(right)),
	};
}
