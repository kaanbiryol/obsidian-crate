import { expect, it } from 'vitest';
import { scanReminderMarkdownContent } from './markdownScan';
import { buildCreatedReminderBlock, buildReminderCompletionPlan, buildUpdatedReminderBlock, planReminderCompletion, setReminderCompletionInContent } from './markdownReminderMutation';
import { ReminderInputError } from './reminderMutationInput';
import type { RecurrenceRule } from '@/reminders/types/reminder';

function saved(completed: boolean, recurrence?: RecurrenceRule) {
	const block = buildCreatedReminderBlock({ content: 'Task', priority: 4, dueDate: new Date('2026-09-21T09:00:00Z'),
		hasTime: true, recurrence, completed, reminderId: 'one' });
	return scanReminderMarkdownContent('Reminders/Inbox.md', `  ${block.checkboxLine}`, 'Reminders').reminders[0]!;
}

it.each([
	['completes a one-off reminder', saved(false), true],
	['reopens a one-off reminder', saved(true), false],
	['advances a recurring reminder', saved(false, { frequency: 'daily' }), true],
	['completes the last occurrence', saved(false, { frequency: 'daily', count: 1 }), true],
	['reopens a counted occurrence', saved(true, { frequency: 'daily', completedCount: 2 }), false],
])('plans the same completion state with and without Markdown: %s', (_name, reminder, completed) => {
	const { checkboxLine, ...state } = buildReminderCompletionPlan(reminder, completed);
	expect(planReminderCompletion(reminder, completed)).toEqual(state);
	expect(checkboxLine.startsWith('  - [')).toBe(true);
	expect(checkboxLine).toContain(state.completed ? '- [x]' : '- [ ]');
	expect(checkboxLine.endsWith('<!-- crate-id:one -->')).toBe(true);
});

it('keeps a monthly reminder on its day after a shorter month', () => {
	const block = buildCreatedReminderBlock({ content: 'Pay rent', priority: 4, dueDate: new Date('2027-01-31T09:00:00Z'),
		hasTime: true, recurrence: { frequency: 'monthly', timezone: 'Europe/Berlin' }, reminderId: 'rent' });
	expect(block.recurrence).toMatchObject({ dayOfMonth: 31 });
	let file = `${block.checkboxLine}\n`;
	const dues: string[] = [];
	for (let index = 0; index < 3; index++) {
		const reminder = scanReminderMarkdownContent('Reminders/Inbox.md', file, 'Reminders').reminders[0]!;
		file = setReminderCompletionInContent(file, { ...reminder, filePath: 'Reminders/Inbox.md' }, true).content;
		dues.push(scanReminderMarkdownContent('Reminders/Inbox.md', file, 'Reminders').reminders[0]!.dueDatetime!);
	}
	expect(dues).toEqual(['2027-02-28T09:00:00.000Z', '2027-03-31T08:00:00.000Z', '2027-04-30T08:00:00.000Z']);
});

it('anchors a monthly reminder saved before the rule carried its day', () => {
	const reminder = { ...saved(false), recurrence: { frequency: 'monthly' as const, timezone: 'UTC' } };
	expect(planReminderCompletion(reminder, true)).toMatchObject({
		dueDatetime: '2026-10-21T09:00:00.000Z', recurrence: { frequency: 'monthly', dayOfMonth: 21, completedCount: 1 },
	});
});

it('keeps a daily reminder at its typed time across a daylight-saving gap', () => {
	// 02:30 does not exist in Berlin on 2027-03-28, so that occurrence moves to 03:30.
	const block = buildCreatedReminderBlock({ content: 'Take medicine', priority: 4, dueDate: new Date('2027-03-27T01:30:00Z'),
		hasTime: true, recurrence: { frequency: 'daily', timezone: 'Europe/Berlin' }, reminderId: 'pill' });
	expect(block.recurrence).toMatchObject({ hour: 2, minute: 30 });
	let file = `${block.checkboxLine}\n`;
	const dues: string[] = [];
	for (let index = 0; index < 3; index++) {
		const reminder = scanReminderMarkdownContent('Reminders/Inbox.md', file, 'Reminders').reminders[0]!;
		file = setReminderCompletionInContent(file, { ...reminder, filePath: 'Reminders/Inbox.md' }, true).content;
		dues.push(scanReminderMarkdownContent('Reminders/Inbox.md', file, 'Reminders').reminders[0]!.dueDatetime!);
	}
	expect(dues).toEqual(['2027-03-28T01:30:00.000Z', '2027-03-29T00:30:00.000Z', '2027-03-30T00:30:00.000Z']);
});

it('anchors the time of a timed repeat saved before the rule carried it', () => {
	const reminder = { ...saved(false), dueDatetime: '2027-03-27T01:30:00.000Z', dueDate: '2027-03-27', recurrence: { frequency: 'daily' as const, timezone: 'Europe/Berlin' } };
	const first = planReminderCompletion(reminder, true);
	expect(first).toMatchObject({ dueDatetime: '2027-03-28T01:30:00.000Z', recurrence: { hour: 2, minute: 30 } });
	expect(planReminderCompletion({ ...reminder, ...first, completed: false }, true).dueDatetime).toBe('2027-03-29T00:30:00.000Z');
});

it('drops the repeat time when a timed repeat becomes date-only', () => {
	const reminder = saved(false, { frequency: 'daily', hour: 9, minute: 0, timezone: 'UTC' });
	const block = buildUpdatedReminderBlock(reminder, { dueDate: new Date(2026, 9, 30), hasTime: false });
	expect(block.recurrence).toEqual({ frequency: 'daily', timezone: 'UTC' });
	expect(scanReminderMarkdownContent('Reminders/Inbox.md', block.checkboxLine, 'Reminders').reminders[0]).toMatchObject({
		dueDate: '2026-10-30', dueDatetime: undefined, recurrence: { frequency: 'daily', timezone: 'UTC' },
	});
});

it.each(['Lunch at 1pm', 'Meet at noon'])('refuses a date-only title the saved-line parser would read differently: %s', content => {
	const build = () => buildCreatedReminderBlock({ content, priority: 4, dueDate: new Date(2026, 9, 30), hasTime: false, reminderId: 'one' });
	expect(build).toThrow(ReminderInputError);
	expect(build).toThrow('This title cannot be saved as a reminder');
	const timed = { ...saved(false), content, rawLine: `- [ ] ${content} 2026-09-21T09:00:00.000Z <!-- crate-id:one -->` };
	expect(() => buildUpdatedReminderBlock(timed, { dueDate: new Date(2026, 9, 30), hasTime: false })).toThrow(ReminderInputError);
});

it.each(['Read pages 13-19', 'Pages 20-30', 'Sprint 14-28'])('writes a date-only due as an ISO date when only that form reads back: %s', content => {
	const created = buildCreatedReminderBlock({ content, priority: 4, dueDate: new Date(2026, 9, 30), hasTime: false, reminderId: 'one' });
	expect(created.checkboxLine).toBe(`- [ ] ${content} 2026-10-30 <!-- crate-id:one -->`);
	expect(scanReminderMarkdownContent('Reminders/Inbox.md', created.checkboxLine, 'Reminders').reminders[0]).toMatchObject({ content, dueDate: '2026-10-30' });
	// A description-only edit of a line schedule normalization wrote keeps working.
	const normalized = { ...saved(false), content, dueDate: '2026-10-30', dueDatetime: undefined, rawLine: `- [ ] ${content} 2026-10-30 <!-- crate-id:one -->` };
	expect(buildUpdatedReminderBlock(normalized, { description: 'Notes' }).checkboxLine).toBe(created.checkboxLine);
});

it('refuses a title whose markers would read back as a different reminder', () => {
	expect(() => buildCreatedReminderBlock({ content: 'Wow !', priority: 4, dueDate: undefined, reminderId: 'one' })).toThrow(ReminderInputError);
	expect(buildCreatedReminderBlock({ content: 'Spaced  title', priority: 4, dueDate: new Date(2026, 9, 30), hasTime: false, reminderId: 'one' }).dueDateKey).toBe('2026-10-30');
});
