import { isRecord } from '../platform/validation';

/** How long the server keeps replaced and deleted file versions and shared checkpoints. */
export const HISTORY_RETENTION_DAYS = [7, 14, 30, 60, 90] as const;
export type HistoryRetentionDays = typeof HISTORY_RETENTION_DAYS[number];
export const DEFAULT_HISTORY_RETENTION_DAYS: HistoryRetentionDays = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_HISTORY_RETENTION_MS = Math.max(...HISTORY_RETENTION_DAYS) * DAY_MS;

export const isHistoryRetentionDays = (value: unknown): value is HistoryRetentionDays =>
	HISTORY_RETENTION_DAYS.includes(value as HistoryRetentionDays);

/** The `/history-retention` body. */
export interface HistoryRetention { days: HistoryRetentionDays }

export function parseHistoryRetention(value: unknown): HistoryRetention | null {
	return isRecord(value) && isHistoryRetentionDays(value.days) ? { days: value.days } : null;
}
