import { isRecord } from '../platform/validation';

/** How long the server keeps replaced and deleted file versions and shared checkpoints. */
export const HISTORY_RETENTION_DAYS = [7, 14, 30, 60, 90] as const;
/** A self-hosted server's storage is its own disk, so it also offers longer periods. */
export const SELF_HOSTED_HISTORY_RETENTION_DAYS = [...HISTORY_RETENTION_DAYS, 180, 365] as const;
export type HistoryRetentionDays = typeof SELF_HOSTED_HISTORY_RETENTION_DAYS[number];
export const DEFAULT_HISTORY_RETENTION_DAYS: HistoryRetentionDays = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_HISTORY_RETENTION_MS = Math.max(...SELF_HOSTED_HISTORY_RETENTION_DAYS) * DAY_MS;

/** Whether `value` is one of `options`, the periods a server offers. */
export const isHistoryRetentionDays = (value: unknown, options: readonly number[] = HISTORY_RETENTION_DAYS): value is HistoryRetentionDays =>
	options.includes(value as number);

/** The `/history-retention` body. A self-hosted server also lists the periods it offers. */
export interface HistoryRetention { days: HistoryRetentionDays; options: readonly HistoryRetentionDays[] }

export function parseHistoryRetention(value: unknown): HistoryRetention | null {
	if (!isRecord(value)) return null;
	const options = Array.isArray(value.options) && value.options.length > 0 && value.options.every(days => isHistoryRetentionDays(days, SELF_HOSTED_HISTORY_RETENTION_DAYS))
		? value.options : HISTORY_RETENTION_DAYS;
	return isHistoryRetentionDays(value.days, options) ? { days: value.days, options } : null;
}
