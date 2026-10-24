import { expect, it } from 'vitest';
import { scanReminderMarkdownContent } from './markdownScan';
import { buildCreatedReminderBlock, buildReminderCompletionPlan, planReminderCompletion } from './markdownReminderMutation';
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
