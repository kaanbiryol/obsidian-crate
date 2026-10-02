import { isEncryptionId } from './encoding';

export const ENCRYPTED_NOTIFICATION_PREFIX = 'crate-notification-v1:';
export interface EncryptedNotification {
	version: 1;
	vaultId: string;
	scopeId: string;
	keyId: string;
	reminderId: string;
	fingerprint: string;
	envelope: string;
}
interface EncryptedSchedule {
	id: string;
	completed: boolean;
	dueDate?: string;
	dueDatetime?: string;
	notification: EncryptedNotification;
}
export interface EncryptedSchedules {
	version: 1;
	reminders: EncryptedSchedule[];
	issue?: 'size' | 'invalid-reminders' | 'scheduling-capacity';
}
export const ENCRYPTED_SCHEDULING_CAPACITY_ISSUE = 'Split this note into smaller projects to enable encrypted notifications. Its reminder text remains available.';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected public reminder field');
}
export function validateEncryptedNotification(value: unknown): asserts value is EncryptedNotification {
	if (!record(value)) throw new Error('Invalid encrypted notification');
	fields(value, ['version', 'vaultId', 'scopeId', 'keyId', 'reminderId', 'fingerprint', 'envelope']);
	if (value.version !== 1 || ![value.vaultId, value.scopeId, value.keyId, value.reminderId].every(isEncryptionId)
		|| typeof value.fingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.fingerprint)
		|| typeof value.envelope !== 'string' || value.envelope.length > 2800 || value.envelope.split('.').length !== 5) throw new Error('Invalid encrypted notification');
}
export function parseEncryptedNotification(content: string): EncryptedNotification | null {
	if (!content.startsWith(ENCRYPTED_NOTIFICATION_PREFIX)) return null;
	const value: unknown = JSON.parse(content.slice(ENCRYPTED_NOTIFICATION_PREFIX.length));
	validateEncryptedNotification(value);
	return value;
}
export function validateEncryptedSchedules(value: unknown): asserts value is EncryptedSchedules {
	if (!record(value)) throw new Error('Missing encrypted reminder scheduling metadata');
	fields(value, ['version', 'reminders', 'issue']);
	if (value.version !== 1 || !Array.isArray(value.reminders) || value.reminders.length > 10_000
		|| (value.issue !== undefined && value.issue !== 'size' && value.issue !== 'invalid-reminders' && value.issue !== 'scheduling-capacity')
		|| (value.issue !== undefined && value.reminders.length !== 0)) throw new Error('Invalid encrypted reminder scheduling metadata');
	for (const reminder of value.reminders) {
		if (!record(reminder)) throw new Error('Invalid encrypted reminder schedule');
		fields(reminder, ['id', 'completed', 'dueDate', 'dueDatetime', 'notification']);
		if (!isEncryptionId(reminder.id) || typeof reminder.completed !== 'boolean'
			|| (reminder.dueDate !== undefined && (typeof reminder.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reminder.dueDate) || !Number.isFinite(Date.parse(reminder.dueDate))))
			|| (reminder.dueDatetime !== undefined && (typeof reminder.dueDatetime !== 'string' || reminder.dueDatetime.length > 40 || !Number.isFinite(Date.parse(reminder.dueDatetime))))) throw new Error('Invalid encrypted reminder schedule');
		validateEncryptedNotification(reminder.notification);
		if (reminder.notification.reminderId !== reminder.id) throw new Error('Encrypted notification identity mismatch');
	}
}
