import { REMINDER_RETRY_DAYS } from '@/protocol/reminder-operation';

// Reading, reminder and upload receipts share this persisted floor. Keep its
// storage key stable; the floor never moves backwards, even if a server clock does.
export const OPERATION_FLOOR = `MAX(
	COALESCE((SELECT CAST(value AS INTEGER) FROM maintenance_state WHERE key = 'reminder_operation_floor'), 0),
	CAST(unixepoch('now') / 86400 AS INTEGER) - ${REMINDER_RETRY_DAYS - 1})`;
export const OPERATION_VALID = `? >= ${OPERATION_FLOOR}
	AND ? <= CAST(unixepoch('now') / 86400 AS INTEGER)`;
