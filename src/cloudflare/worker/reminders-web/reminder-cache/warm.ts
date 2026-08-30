import { readStoredMarkdownFiles, type StoredMarkdownFileMetadata } from '../../storage';
import type { Env } from '../../types';
import { scanReminderMarkdownFile } from '../scan';
import {
	REMINDER_INDEX_WARM_MAX_BYTES,
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
		if (selected.length > 0 && selectedBytes + file.size > REMINDER_INDEX_WARM_MAX_BYTES) break;
		selected.push(file);
		selectedBytes += file.size;
	}
	return selected;
}

export async function parseReminderCacheEntries(
	env: Env,
	folderPath: string,
	metadata: StoredMarkdownFileMetadata[],
): Promise<ReminderFileCacheEntry[]> {
	const freshFiles = await readStoredMarkdownFiles(env.BUCKET, metadata);
	if (freshFiles.length !== metadata.length) {
		throw new Error('One or more reminder files could not be read from storage');
	}
	return freshFiles.map((file): ReminderFileCacheEntry => ({
		filePath: file.path,
		fileHash: file.hash,
		reminders: scanReminderMarkdownFile(file.path, file.content, folderPath),
	}));
}
