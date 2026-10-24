import { REMINDER_RETRY_DAYS } from '@/protocol/reminder-operation';

// Reading, reminder and upload receipts share this persisted floor. Keep its
// storage key stable; the floor never moves backwards, even if a server clock does.
export const OPERATION_FLOOR = `MAX(
	COALESCE((SELECT CAST(value AS INTEGER) FROM maintenance_state WHERE key = 'reminder_operation_floor'), 0),
	CAST(unixepoch('now') / 86400 AS INTEGER) - ${REMINDER_RETRY_DAYS - 1})`;
export const OPERATION_VALID = `? >= ${OPERATION_FLOOR}
	AND ? <= CAST(unixepoch('now') / 86400 AS INTEGER)`;

/** Whether a new operation from this day may still record a receipt. The
 * window is read from D1 so it agrees with the floor that prunes receipts.
 * Writers look up a saved receipt first, so a replay never expires. */
export async function isRetryableOperationDay(db: D1Database, day: number): Promise<boolean> {
	return Boolean(await db.prepare(`SELECT 1 WHERE ${OPERATION_VALID}`).bind(day, day).first());
}
