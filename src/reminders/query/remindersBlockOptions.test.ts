import { describe, expect, it } from 'vitest';

import {
	extractRemindersBlockInfo,
	isRemindersBlockStart,
	parseRemindersBlockOptions,
	setRemindersBlockShowCompleted,
} from './remindersBlockOptions';

describe('reminders block options', () => {
	it('extracts supported reminders code fences', () => {
		const blockInfo = extractRemindersBlockInfo([
			'```reminders-upcoming',
			'project: Work',
			'show-completed: true',
			'```',
		].join('\n'));

		expect(blockInfo).toEqual({
			content: 'project: Work\nshow-completed: true',
			type: 'reminders-upcoming',
			isToday: false,
			isUpcoming: true,
		});
	});

	it('rejects non-reminders code fences', () => {
		expect(extractRemindersBlockInfo('```tasks\nnot ours\n```')).toBeNull();
		expect(extractRemindersBlockInfo('plain text')).toBeNull();
		expect(isRemindersBlockStart('```tasks')).toBe(false);
	});

	it('parses live-preview options for special reminders block types', () => {
		const todayBlock = extractRemindersBlockInfo('```reminders-today\nproject: Work\n```');
		const upcomingBlock = extractRemindersBlockInfo('```reminders-upcoming\nproject: Work\n```');

		expect(todayBlock).not.toBeNull();
		expect(upcomingBlock).not.toBeNull();
		expect(parseRemindersBlockOptions(todayBlock!)).toMatchObject({
			showToday: true,
			showUpcoming: false,
			projectFilter: undefined,
		});
		expect(parseRemindersBlockOptions(upcomingBlock!)).toMatchObject({
			showToday: false,
			showUpcoming: true,
			projectFilter: 'Work',
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
