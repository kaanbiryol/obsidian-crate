import { describe, expect, it } from 'vitest';
import {
	getReminderProjectFilePath,
	normalizeReminderProjectPath,
} from './reminderProjectPath';

describe('reminderProjectPath', () => {
	it('normalizes regular and nested project paths', () => {
		expect(normalizeReminderProjectPath(' Work ')).toBe('Work');
		expect(normalizeReminderProjectPath('Personal/Health')).toBe('Personal/Health');
		expect(getReminderProjectFilePath('Reminders', 'Personal/Health'))
			.toBe('Reminders/Personal/Health.md');
	});

	it.each([
		'',
		'/',
		'/Work',
		'Work/',
		'Work//Health',
		'Work/ Health',
		'Work /Health',
		'Work/../Health',
		'Work/./Health',
		'Work\\Health',
		'Work\u0000Health',
	])('rejects unsafe project path %j', (project) => {
		expect(normalizeReminderProjectPath(project)).toBeNull();
	});
});
