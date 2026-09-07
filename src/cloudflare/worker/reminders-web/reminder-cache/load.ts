import { queryRows } from '../../db';
import type { RemoteReminderRecord } from '../types';
import {
	REMINDER_CACHE_PARSER_VERSION,
	type ReminderFileCacheEntry,
	type ReminderFileCacheRow,
} from './types';

function parseCachedReminders(parsed: unknown): RemoteReminderRecord[] | null {
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
		let issue: string | undefined;
		let value: unknown;
		try {
			// A large folder can contain thousands of cache rows. Decode each once.
			value = JSON.parse(row.reminders_json) as unknown;
			if (value && typeof value === 'object' && 'issue' in value && typeof value.issue === 'string') {
				issue = value.issue;
			}
		} catch { continue; /* Invalid cache is rebuilt from storage. */ }
		const reminders = issue ? [] : parseCachedReminders(value);
		if (!reminders) continue;
		entries.set(row.file_path, {
			filePath: row.file_path,
			fileHash: row.file_hash,
			reminders,
			issue,
		});
	}
	return entries;
}
