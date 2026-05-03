import type { RecurrenceRule } from '@/reminders/types/reminder';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { corsResponse } from '../cors';
import { parseOptionalString, sanitizePath } from '../utils';
import type { ReminderMutationWorkspace } from './types';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type RecurrenceMutationResult =
	| { ok: true; value: RecurrenceRule | null | undefined }
	| { ok: false; response: Response };

export function parseFolderPath(value: unknown): string | null {
	const parsed = parseOptionalString(value, 512);
	return parsed ? sanitizePath(parsed) : null;
}

export function parseProjectPath(value: unknown): string | null {
	const parsed = parseOptionalString(value, 256);
	return parsed ? sanitizePath(parsed) : null;
}

export function hasNonEmptyStringValue(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

function parseOptionalAllDayNotificationTime(value: unknown): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (value === null) {
		return null;
	}

	const parsed = parseOptionalString(value, 5);
	if (!parsed) {
		return null;
	}

	const match = TIME_PATTERN.exec(parsed);
	return match ? `${match[1]}:${match[2]}` : null;
}

export function parseRecurrenceMutationValue(value: unknown): RecurrenceMutationResult {
	if (value === undefined) {
		return { ok: true, value: undefined };
	}

	if (value === null) {
		return { ok: true, value: null };
	}

	if (typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, response: corsResponse({ error: 'Invalid recurrence' }, 400) };
	}

	const raw = value as Partial<RecurrenceRule>;
	if (raw.frequency !== 'daily' && raw.frequency !== 'weekly' && raw.frequency !== 'monthly') {
		return { ok: false, response: corsResponse({ error: 'Invalid recurrence frequency' }, 400) };
	}

	const rule: RecurrenceRule = { frequency: raw.frequency };
	if (raw.interval !== undefined) {
		if (!Number.isInteger(raw.interval) || raw.interval < 1 || raw.interval > 365) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence interval' }, 400) };
		}
		rule.interval = raw.interval;
	}
	if (raw.daysOfWeek !== undefined) {
		if (
			!Array.isArray(raw.daysOfWeek)
			|| raw.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
		) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence daysOfWeek' }, 400) };
		}
		rule.daysOfWeek = Array.from(new Set(raw.daysOfWeek)).sort((a, b) => a - b);
	}
	if (raw.dayOfMonth !== undefined) {
		if (!Number.isInteger(raw.dayOfMonth) || raw.dayOfMonth < 1 || raw.dayOfMonth > 31) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence dayOfMonth' }, 400) };
		}
		rule.dayOfMonth = raw.dayOfMonth;
	}
	if (raw.hour !== undefined) {
		if (!Number.isInteger(raw.hour) || raw.hour < 0 || raw.hour > 23) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence hour' }, 400) };
		}
		rule.hour = raw.hour;
	}
	if (raw.minute !== undefined) {
		if (!Number.isInteger(raw.minute) || raw.minute < 0 || raw.minute > 59) {
			return { ok: false, response: corsResponse({ error: 'Invalid recurrence minute' }, 400) };
		}
		rule.minute = raw.minute;
	}
	if (typeof raw.timezone === 'string' && raw.timezone.trim()) {
		rule.timezone = raw.timezone.trim();
	}

	return { ok: true, value: normalizeRecurrenceRule(rule) };
}

export function parseReminderMutationWorkspace(
	value: Record<string, unknown>,
): ReminderMutationWorkspace | Response {
	const folderPath = parseFolderPath(value.folderPath);
	if (!folderPath) {
		return corsResponse({ error: 'folderPath required' }, 400);
	}

	const allDayNotificationTime = parseOptionalAllDayNotificationTime(value.allDayNotificationTime);
	if (value.allDayNotificationTime !== undefined && allDayNotificationTime === null && value.allDayNotificationTime !== null) {
		return corsResponse({ error: 'Invalid allDayNotificationTime' }, 400);
	}

	return { folderPath, allDayNotificationTime };
}
