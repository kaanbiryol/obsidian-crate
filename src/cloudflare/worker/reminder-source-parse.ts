import { ReminderIdentityConflictError } from './reminder-source-identity';
import { decodeMarkdownBytes, MarkdownEncodingError } from '@/reminders/core/markdownEncoding';
import { scanReminderMarkdownFile } from './reminders-web/scan';
import { REMINDER_INDEX_MAX_FILE_BYTES } from './reminders-web/reminder-cache/types';
import type { RemoteReminderRecord } from './reminders-web/types';
import { MAX_ENCRYPTED_PUBLIC_DATA_BYTES, parseEncryptedFile } from '../../encryption/file-format';
import { validateEncryptedSchedules, ENCRYPTED_NOTIFICATION_PREFIX, ENCRYPTED_SCHEDULING_CAPACITY_ISSUE } from '../../encryption/notification-format';

export class PermanentReminderSourceError extends Error {}
export function isPermanentSourceError(error: unknown): boolean {
  return error instanceof PermanentReminderSourceError || error instanceof MarkdownEncodingError || error instanceof ReminderIdentityConflictError;
}

type ParsedReminderSource =
	| { reminders: RemoteReminderRecord[]; issue?: undefined }
	| { reminders: []; issue: string };

export const REMINDER_SOURCE_SIZE_ISSUE = 'Split this note into files of 1 MiB or smaller to use its reminders. The vault file remains synced.';

/** Ciphertext includes base64/JWE overhead and bounded public scheduling data.
 * The client validates plaintext size; the server can only bound the transport. */
export function reminderSourceByteLimit(encrypted: boolean): number {
	return encrypted ? 2 * REMINDER_INDEX_MAX_FILE_BYTES + MAX_ENCRYPTED_PUBLIC_DATA_BYTES : REMINDER_INDEX_MAX_FILE_BYTES;
}

/** Domain parsing is optional; an uncertain source must never look like an empty note. */
export function parseReminderSource(path: string, content: string | ArrayBuffer, folderPath = '', encrypted = false): ParsedReminderSource {
	const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
	if (encrypted) {
		try {
			const packet = parseEncryptedFile(typeof content === 'string' ? content : new Uint8Array(content));
			validateEncryptedSchedules(packet.publicData);
			if (packet.publicData.issue) return { reminders: [], issue: packet.publicData.issue === 'size' ? REMINDER_SOURCE_SIZE_ISSUE
				: packet.publicData.issue === 'scheduling-capacity' ? ENCRYPTED_SCHEDULING_CAPACITY_ISSUE : 'Repair the reminder metadata on an unlocked device to resume notifications.' };
			return { reminders: packet.publicData.reminders.map(item => {
				if (item.notification.vaultId !== packet.descriptor.vaultId || item.notification.scopeId !== packet.descriptor.scopeId) throw new Error('Notification scope mismatch');
				return { id: item.id, completed: item.completed, dueDate: item.dueDate, dueDatetime: item.dueDatetime,
					content: ENCRYPTED_NOTIFICATION_PREFIX + JSON.stringify(item.notification), project: '',
					priority: 4, filePath: path, lineNumber: 0, rawLine: '', contentHash: '' };
			}) };
		} catch { return { reminders: [], issue: 'Encrypted reminder scheduling metadata is invalid. Sync this note from an unlocked device.' }; }
	}
	if (bytes.byteLength > REMINDER_INDEX_MAX_FILE_BYTES) {
		return { reminders: [], issue: REMINDER_SOURCE_SIZE_ISSUE };
	}
	try {
		return { reminders: scanReminderMarkdownFile(path, decodeMarkdownBytes(bytes), folderPath) };
	} catch (error) {
		const reason = error instanceof Error ? error.message.slice(0, 300) : 'Invalid reminder metadata';
		return { reminders: [], issue: `Repair the reminder metadata in this note to resume its reminders. The vault file remains synced. ${reason}` };
	}
}
