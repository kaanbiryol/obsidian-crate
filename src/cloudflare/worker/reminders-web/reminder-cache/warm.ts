import { readStoredMarkdownFiles, type StoredMarkdownFileMetadata } from '../../storage';
import type { Env } from '../../types';
import { scanReminderMarkdownFile } from '../scan';
import {
	REMINDER_INDEX_WARM_MAX_BYTES,
	REMINDER_INDEX_MAX_FILE_BYTES,
	REMINDER_INDEX_WARM_MAX_FILES,
	type ReminderFileCacheEntry,
} from './types';

export function selectReminderIndexWarmBatch(
	metadata: StoredMarkdownFileMetadata[],
): StoredMarkdownFileMetadata[] {
	const selected: StoredMarkdownFileMetadata[] = [];
	let selectedBytes = 0;
	for (const file of metadata) {
		if (selected.length >= REMINDER_INDEX_WARM_MAX_FILES) break;
    const bytes = file.size <= REMINDER_INDEX_MAX_FILE_BYTES ? file.size : 0;
		if (selected.length > 0 && selectedBytes + bytes > REMINDER_INDEX_WARM_MAX_BYTES) break;
		selected.push(file);
		selectedBytes += bytes;
	}
	return selected;
}

export async function parseReminderCacheEntries(
	env: Env,
	folderPath: string,
	metadata: StoredMarkdownFileMetadata[],
): Promise<ReminderFileCacheEntry[]> {
	const readable = metadata.filter(file => file.size <= REMINDER_INDEX_MAX_FILE_BYTES);
	const skipped: ReminderFileCacheEntry[] = metadata.filter(file => file.size > REMINDER_INDEX_MAX_FILE_BYTES).map(file => ({ filePath: file.path, fileHash: file.hash, reminders: [], issue: 'Split this note into files of 1 MiB or smaller to use its reminders in the web app. The vault file remains synced.' }));
	const freshFiles = await readStoredMarkdownFiles(env.BUCKET, readable);
	if (freshFiles.length !== readable.length) {
		throw new Error('One or more reminder files could not be read from storage');
	}
	return skipped.concat(freshFiles.map((file): ReminderFileCacheEntry => ({
		filePath: file.path,
		fileHash: file.hash,
		reminders: scanReminderMarkdownFile(file.path, file.content, folderPath),
	})));
}
