import { describe, expect, it } from 'vitest';

import {
	parseRemindersBlockOptions,
	setRemindersBlockShowCompleted,
} from './remindersBlockOptions';

describe('reminders block options', () => {
	it('parses options for special reminders block types', () => {
		expect(parseRemindersBlockOptions({ type: 'reminders-today', content: 'project: Work' })).toMatchObject({
			showToday: true,
			showUpcoming: false,
			projectFilter: 'Work',
		});
		expect(parseRemindersBlockOptions({ type: 'reminders-upcoming', content: 'project: Work' })).toMatchObject({
			showToday: false,
			showUpcoming: true,
			projectFilter: 'Work',
		});
	});

	it('parses the same options from reading view block sources', () => {
		expect(parseRemindersBlockOptions({ type: 'reminders', content: 'project: Work\nshow-completed: true' })).toEqual({
			projectFilter: 'Work',
			showCompleted: true,
			showToday: false,
			showUpcoming: false,
		});
		expect(parseRemindersBlockOptions({ type: 'reminders-today', content: '' })).toEqual({
			showCompleted: false,
			showToday: true,
			showUpcoming: false,
		});
	});

	it('adds the show-completed option before the closing fence', () => {
		expect(setRemindersBlockShowCompleted([
			'```reminders',
			'project: Work',
			'```',
		].join('\n'), true)).toBe([
			'```reminders',
			'project: Work',
			'show-completed: true',
			'```',
		].join('\n'));
	});

	it.each([
		['~~~', '~~~'],
		['````', '````'],
	])('finds the closing %s fence', (open, close) => {
		expect(setRemindersBlockShowCompleted([`${open}reminders`, '```', close].join('\n'), true))
			.toBe([`${open}reminders`, '```', 'show-completed: true', close].join('\n'));
	});

	it('cannot update a block without its fences', () => {
		expect(setRemindersBlockShowCompleted(['> ```reminders', '> ```'].join('\n'), true)).toBeNull();
		expect(setRemindersBlockShowCompleted(['~~~reminders', 'project: Work', '```'].join('\n'), true)).toBeNull();
	});

	it('replaces the show-completed option and preserves its indentation', () => {
		expect(setRemindersBlockShowCompleted([
			'```reminders',
			'  show-completed: false',
			'project: Work',
			'```',
		].join('\n'), true)).toBe([
			'```reminders',
			'project: Work',
			'  show-completed: true',
			'```',
		].join('\n'));
	});
});
