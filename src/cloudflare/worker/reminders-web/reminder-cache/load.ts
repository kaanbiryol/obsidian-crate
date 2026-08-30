import { queryRows } from '../../db';
import type { RemoteReminderRecord } from '../types';
import {
	REMINDER_CACHE_PARSER_VERSION,
	type ReminderFileCacheEntry,
	type ReminderFileCacheRow,
} from './types';

function parseCachedReminders(value: string): RemoteReminderRecord[] | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return null;
		if (!parsed.every((reminder) => (
			reminder !== null
			&& typeof reminder === 'object'
			&& typeof (reminder as Partial<RemoteReminderRecord>).id === 'string'
			&& typeof (reminder as Partial<RemoteReminderRecord>).content === 'string'
			&& typeof (reminder as Partial<RemoteReminderRecord>).filePath === 'string'
			&& typeof (reminder as Partial<RemoteReminderRecord>).lineNumber === 'number'
		))) {
			return null;
		}
		return parsed as RemoteReminderRecord[];
	} catch {
		return null;
	}
}

export async function loadReminderFileCache(
	db: D1Database,
	folderPath: string,
): Promise<Map<string, ReminderFileCacheEntry>> {
	const rows = await queryRows<ReminderFileCacheRow>(db.prepare(`SELECT file_path, file_hash, parser_version, reminders_json
		FROM reminder_file_cache
		WHERE folder_path = ?`).bind(folderPath));
	const entries = new Map<string, ReminderFileCacheEntry>();
	for (const row of rows) {
		if (row.parser_version !== REMINDER_CACHE_PARSER_VERSION) continue;
		const reminders = parseCachedReminders(row.reminders_json);
		if (!reminders) continue;
		entries.set(row.file_path, {
			filePath: row.file_path,
			fileHash: row.file_hash,
			reminders,
		});
	}
	return entries;
}
