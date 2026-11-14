import { REMINDER_RETRY_DAYS } from '@/protocol/reminder-operation';

/** Days an upload or version restore can be confirmed by replaying its operation.
 * The plugin retries from its upload journal within a sync or two, and the changelog it
 * reconciles against is kept 30 days as well. */
export const UPLOAD_RETRY_DAYS = 30;

const TODAY = "CAST(unixepoch('now') / 86400 AS INTEGER)";
/** A retry floor persisted under `key`. It never moves backwards, even if a server clock does. */
const operationFloor = (key: string, days: number) => `MAX(
	COALESCE((SELECT CAST(value AS INTEGER) FROM maintenance_state WHERE key = '${key}'), 0),
	${TODAY} - ${days - 1})`;
const operationValid = (floor: string) => `? >= ${floor}
	AND ? <= ${TODAY}`;

/** Reading and reminder receipts share this floor. Keep its storage key stable. */
export const OPERATION_FLOOR_KEY = 'reminder_operation_floor';
export const OPERATION_FLOOR = operationFloor(OPERATION_FLOOR_KEY, REMINDER_RETRY_DAYS);
export const OPERATION_VALID = operationValid(OPERATION_FLOOR);

/** Upload receipts have their own, shorter window. */
export const UPLOAD_OPERATION_FLOOR_KEY = 'upload_operation_floor';
export const UPLOAD_OPERATION_FLOOR = operationFloor(UPLOAD_OPERATION_FLOOR_KEY, UPLOAD_RETRY_DAYS);
export const UPLOAD_OPERATION_VALID = operationValid(UPLOAD_OPERATION_FLOOR);
