import { normalizeReminderProjectPath } from '@/reminders/core/reminderProjectPath';
import { ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { corsResponse } from '../cors';
import { parseOptionalString, sanitizePath } from '../request-validation';
import type { ReminderMutationWorkspace } from './types';

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

/** Plaintext routes answer an invalid repeat without an input field or code. */
export function recurrenceInputResponse(error: unknown): Response {
	if (error instanceof ReminderInputError && error.field === 'recurrence') return corsResponse({ error: error.message }, 400);
	throw error;
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
