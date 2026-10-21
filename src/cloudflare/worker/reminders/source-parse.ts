import { ReminderIdentityConflictError } from './source-identity';
import { decodeMarkdownBytes, MarkdownEncodingError } from '@/reminders/core/markdownEncoding';
import { reminderDescriptionErrorFromMessage } from '@/reminders/core/reminderDescription';
import type { SyncIssueCode } from '@/protocol/sync-issues';
import { scanReminderMarkdownFile } from './scan';
import { MAX_REMINDER_NOTE_BYTES } from '@/reminders/core/constants';
import type { RemoteReminderRecord } from './types';
import { MAX_ENCRYPTED_PUBLIC_DATA_BYTES, parseEncryptedFile } from '../../../encryption/file-format';
import { validateEncryptedSchedules, ENCRYPTED_NOTIFICATION_PREFIX, ENCRYPTED_SCHEDULING_CAPACITY_ISSUE } from '../../../encryption/notification-format';

export class PermanentReminderSourceError extends Error {}
export function isPermanentSourceError(error: unknown): boolean {
  return error instanceof PermanentReminderSourceError || error instanceof MarkdownEncodingError || error instanceof ReminderIdentityConflictError;
}

type ParsedReminderSource =
	| { reminders: RemoteReminderRecord[]; issue?: undefined }
	| { reminders: []; issue: string };

export const REMINDER_SOURCE_SIZE_ISSUE = 'Split this note into files of 1 MiB or smaller to use its reminders. The vault file remains synced.';
export const REMINDER_PROJECTION_SIZE_ISSUE = 'Split this reminder note into smaller files to schedule notifications';
export const DUPLICATE_COMMITTED_REMINDER_ISSUE = 'Duplicate reminder identity in committed file';
const MARKDOWN_ENCODING_ISSUE = new MarkdownEncodingError().message;
const IDENTITY_CONFLICT_ISSUE = new ReminderIdentityConflictError().message;

/** Source failures persist as text. Recover the stable code of text written here
 * so clients need not match its wording; other failures, such as transient
 * storage errors, have no code. */
export function reminderSourceIssueCode(issue: string): { code: SyncIssueCode; line?: number } | undefined {
	if (issue === REMINDER_SOURCE_SIZE_ISSUE || issue === REMINDER_PROJECTION_SIZE_ISSUE) return { code: 'reminder-note-too-large' };
	if (issue === IDENTITY_CONFLICT_ISSUE || issue === DUPLICATE_COMMITTED_REMINDER_ISSUE) return { code: 'duplicate-reminder-id' };
	if (issue.endsWith(MARKDOWN_ENCODING_ISSUE)) return { code: 'invalid-markdown-encoding' };
	return reminderDescriptionErrorFromMessage(issue);
}

/** Ciphertext includes base64/JWE overhead and bounded public scheduling data.
 * The client validates plaintext size; the server can only bound the transport. */
export function reminderSourceByteLimit(encrypted: boolean): number {
	return encrypted ? 2 * MAX_REMINDER_NOTE_BYTES + MAX_ENCRYPTED_PUBLIC_DATA_BYTES : MAX_REMINDER_NOTE_BYTES;
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
					priority: 4, filePath: path, lineNumber: 0, rawLine: '' };
			}) };
		} catch { return { reminders: [], issue: 'Encrypted reminder scheduling metadata is invalid. Sync this note from an unlocked device.' }; }
	}
	if (bytes.byteLength > MAX_REMINDER_NOTE_BYTES) {
		return { reminders: [], issue: REMINDER_SOURCE_SIZE_ISSUE };
	}
	try {
		return { reminders: scanReminderMarkdownFile(path, decodeMarkdownBytes(bytes), folderPath) };
	} catch (error) {
		const reason = error instanceof Error ? error.message.slice(0, 300) : 'Invalid reminder metadata';
		return { reminders: [], issue: `Repair the reminder metadata in this note to resume its reminders. The vault file remains synced. ${reason}` };
	}
}
