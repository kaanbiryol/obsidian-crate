import type { RecurrenceRule } from '@/reminders/types/reminder';
import { normalizeReminderProjectPath } from '@/reminders/core/reminderProjectPath';
import { validateRecurrence } from '@/reminders/core/validateRecurrence';
import { corsResponse } from '../cors';
import { parseOptionalString, sanitizePath } from '../utils';
import type { ReminderMutationWorkspace } from './types';

export type RecurrenceMutationResult =
	| { ok: true; value: RecurrenceRule | null | undefined }
	| { ok: false; response: Response };

export function parseFolderPath(value: unknown): string | null {
	const parsed = parseOptionalString(value, 512);
	return parsed ? sanitizePath(parsed) : null;
}

export function parseProjectPath(value: unknown): string | null {
	const parsed = parseOptionalString(value, 256);
	return parsed ? normalizeReminderProjectPath(parsed) : null;
}

export function parseReminderSourceFilePath(value: unknown, folderPath: string): string | null {
	const parsed = parseOptionalString(value, 512);
	if (!parsed) return null;
	const sanitized = sanitizePath(parsed);
	return sanitized
		&& sanitized.startsWith(`${folderPath}/`)
		&& sanitized.toLowerCase().endsWith('.md')
		? sanitized
		: null;
}

export function hasNonEmptyStringValue(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

export function parseRecurrenceMutationValue(value: unknown): RecurrenceMutationResult {
	if (value === undefined) {
		return { ok: true, value: undefined };
	}

	if (value === null) {
		return { ok: true, value: null };
	}

	const result = validateRecurrence(value);
	return 'rule' in result ? { ok: true, value: result.rule }
		: { ok: false, response: corsResponse({ error: result.error }, 400) };
}

export function parseReminderMutationWorkspace(
	value: Record<string, unknown>,
): ReminderMutationWorkspace | Response {
	const folderPath = parseFolderPath(value.folderPath);
	if (!folderPath) {
		return corsResponse({ error: 'folderPath required' }, 400);
	}

	return { folderPath };
}
