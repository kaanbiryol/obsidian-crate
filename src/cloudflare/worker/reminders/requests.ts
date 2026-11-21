import { normalizeReminderProjectPath } from '@/reminders/core/reminderProjectPath';
import { corsResponse } from '../http/cors';
import { parseOptionalString, sanitizePath } from '../http/request-validation';
import type { ReminderMutationWorkspace } from './types';
import { isReminderNotePath } from '../../../protocol/reminder-archive-path';

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
	return sanitized && isReminderNotePath(sanitized, folderPath) ? sanitized : null;
}

export function hasNonEmptyStringValue(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
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
