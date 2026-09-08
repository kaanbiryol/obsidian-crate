import { REMINDER_RETRY_DAYS } from '@/protocol/reminder-operation';
import { corsResponse } from '../cors';

// The persisted floor never moves backwards, even if a server clock does.
export const REMINDER_OPERATION_FLOOR = `MAX(
	COALESCE((SELECT CAST(value AS INTEGER) FROM maintenance_state WHERE key = 'reminder_operation_floor'), 0),
	CAST(unixepoch('now') / 86400 AS INTEGER) - ${REMINDER_RETRY_DAYS - 1})`;
export const REMINDER_OPERATION_VALID = `? >= ${REMINDER_OPERATION_FLOOR}
	AND ? <= CAST(unixepoch('now') / 86400 AS INTEGER)`;

export function expiredReminderOperation(): Response {
	return corsResponse({ code: 'operation_expired', error: 'This change is outside the server’s retry window. An earlier attempt may have synced. Export it and compare your current reminders before restoring missing work.' }, 410);
}
