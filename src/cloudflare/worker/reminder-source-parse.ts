import { scanReminderMarkdownFile } from './reminders-web/scan';
import { REMINDER_INDEX_MAX_FILE_BYTES } from './reminders-web/reminder-cache/types';
import type { RemoteReminderRecord } from './reminders-web/types';

type ParsedReminderSource =
	| { reminders: RemoteReminderRecord[]; issue?: undefined }
	| { reminders: []; issue: string };

export const REMINDER_SOURCE_SIZE_ISSUE = 'Split this note into files of 1 MiB or smaller to use its reminders. The vault file remains synced.';

/** Domain parsing is optional; an uncertain source must never look like an empty note. */
export function parseReminderSource(path: string, content: string | ArrayBuffer, folderPath = ''): ParsedReminderSource {
	const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
	if (bytes.byteLength > REMINDER_INDEX_MAX_FILE_BYTES) {
		return { reminders: [], issue: REMINDER_SOURCE_SIZE_ISSUE };
	}
	try {
		return { reminders: scanReminderMarkdownFile(path, new TextDecoder().decode(bytes), folderPath) };
	} catch (error) {
		const reason = error instanceof Error ? error.message.slice(0, 300) : 'Invalid reminder metadata';
		return { reminders: [], issue: `Repair the reminder metadata in this note to resume its reminders. The vault file remains synced. ${reason}` };
	}
}
