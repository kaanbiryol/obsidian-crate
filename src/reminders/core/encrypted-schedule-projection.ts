import { sealNotification, type NotificationKeys } from '../../encryption/notification-keys';
import type { EncryptedSchedules } from '../../encryption/notification-format';
import { MAX_ENCRYPTED_PUBLIC_DATA_BYTES } from '../../encryption/file-format';
import { isMarkdownPath } from '../../protocol/note-paths';
import { readableLinkText } from './grammar/markdownLinks';
import { scanReminderMarkdownContent } from './markdownScan';
import { decodeMarkdownBytes } from './markdownEncoding';
import { MAX_REMINDER_NOTE_BYTES, MAX_REMINDERS_PER_NOTE } from './constants';

const NOTIFICATION_CONCURRENCY = 8;

/** Publish only the current occurrence; recurrence advances on client completion.
 * Only notes inside a reminders folder carry schedules. Invalid Markdown
 * preserves the server's existing schedules via quarantine. */
export async function createReminderProjection(keys: NotificationKeys, folders: readonly string[], path: string, bytes: ArrayBuffer): Promise<EncryptedSchedules | null> {
	const folder = folders.filter(folder => folder && path.startsWith(`${folder}/`)).sort((left, right) => right.length - left.length)[0];
	if (!folder || !isMarkdownPath(path)) return null;
	if (bytes.byteLength > MAX_REMINDER_NOTE_BYTES) return { version: 1, reminders: [], issue: 'size' };
	let scanned;
	try { scanned = scanReminderMarkdownContent(path, decodeMarkdownBytes(bytes), folder).reminders; }
	catch { return { version: 1, reminders: [], issue: 'invalid-reminders' }; }
	if (scanned.length > MAX_REMINDERS_PER_NOTE) return { version: 1, reminders: [], issue: 'scheduling-capacity' };
	const reminders: EncryptedSchedules['reminders'] = [];
	let projectionBytes = new TextEncoder().encode(JSON.stringify({ version: 1, reminders: [] })).byteLength;
	for (let offset = 0; offset < scanned.length; offset += NOTIFICATION_CONCURRENCY) {
		const chunk = scanned.slice(offset, offset + NOTIFICATION_CONCURRENCY);
		const notices = await Promise.all(chunk.map(reminder => sealNotification(keys,
			{ id: reminder.id, title: readableLinkText(reminder.content), body: reminder.project })));
		for (const [index, reminder] of chunk.entries()) {
			const schedule = { id: reminder.id, completed: reminder.completed,
				...(reminder.dueDate ? { dueDate: reminder.dueDate } : {}),
				...(reminder.dueDatetime ? { dueDatetime: reminder.dueDatetime } : {}), notification: notices[index]! };
			projectionBytes += new TextEncoder().encode(JSON.stringify(schedule)).byteLength + (reminders.length ? 1 : 0);
			// Optional scheduling must not prevent encrypting and syncing the vault
			// file, including while converting an existing large reminders note.
			if (projectionBytes > MAX_ENCRYPTED_PUBLIC_DATA_BYTES) return { version: 1, reminders: [], issue: 'scheduling-capacity' };
			reminders.push(schedule);
		}
	}
	return { version: 1, reminders };
}
