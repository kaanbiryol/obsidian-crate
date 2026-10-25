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

it.each(['Read pages 13-19', 'Pages 20-30', 'Sprint 14-28'])('refuses a date-only title the saved-line parser would reject: %s', content => {
	const build = () => buildCreatedReminderBlock({ content, priority: 4, dueDate: new Date(2026, 9, 30), hasTime: false, reminderId: 'one' });
	expect(build).toThrow(ReminderInputError);
	expect(build).toThrow('This title cannot be saved as a reminder');
	// The timed form keeps an ISO date, which reads back.
	expect(buildCreatedReminderBlock({ content, priority: 4, dueDate: new Date('2026-10-30T09:00:00Z'), hasTime: true, reminderId: 'one' }).content).toBe(content);
	const timed = { ...saved(false), content, rawLine: `- [ ] ${content} 2026-09-21T09:00:00.000Z <!-- crate-id:one -->` };
	expect(() => buildUpdatedReminderBlock(timed, { dueDate: new Date(2026, 9, 30), hasTime: false })).toThrow(ReminderInputError);
});

it('refuses a title whose markers would read back as a different reminder', () => {
	expect(() => buildCreatedReminderBlock({ content: 'Wow !', priority: 4, dueDate: undefined, reminderId: 'one' })).toThrow(ReminderInputError);
	expect(buildCreatedReminderBlock({ content: 'Spaced  title', priority: 4, dueDate: new Date(2026, 9, 30), hasTime: false, reminderId: 'one' }).dueDateKey).toBe('2026-10-30');
});
