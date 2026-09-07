import type { RemoteReminderRecord } from '../types';

// Bump when parsing behavior or the cached reminder shape changes. The list
// ETag includes this value so clients revalidate even when file hashes do not.
export const REMINDER_CACHE_PARSER_VERSION = 5;
export const REMINDER_INDEX_MAX_FILE_BYTES = 1024 * 1024;
export const REMINDER_INDEX_WARM_MAX_FILES = 20;
export const REMINDER_INDEX_WARM_MAX_BYTES = 2 * 1024 * 1024;
export const REMINDER_CACHE_MAX_VALUE_BYTES = 1536 * 1024;

export interface ReminderFileCacheRow {
	file_path: string;
	file_hash: string;
	parser_version: number;
	reminders_json: string;
}

export interface ReminderFileCacheEntry {
	filePath: string;
	fileHash: string;
	reminders: RemoteReminderRecord[];
	issue?: string;
}

export type IncrementalReminderIndexResult =
	| { ready: false; reason: 'warming'; remainingFiles: number }
	| { ready: true; reminders: RemoteReminderRecord[]; projects: string[]; issues: Array<{ path: string; reason: string }> };
