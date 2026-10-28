import { describe, expect, it } from 'vitest';
import { buildCreatedReminderBlock } from './markdownReminderMutation';
import { setReminderCompletionInContent } from './reminderCompletion';
import { scanReminderMarkdownContent } from './markdownScan';
import { predictReminderCompletion } from '@/pwa/reminders/outbox/reminder-optimistic-state';

const read = (content: string) => scanReminderMarkdownContent('Reminders/Inbox.md', content, 'Reminders').reminders[0]!;
function source(timed: boolean, count = 3) {
	return buildCreatedReminderBlock({ content: 'Current occurrence', reminderId: 'one', priority: 4,
		dueDate: new Date('2099-03-01T09:00:37.123Z'), hasTime: timed,
		recurrence: { frequency: 'daily', timezone: 'UTC', count, completedCount: count - 1,
			...(timed ? { hour: 9, minute: 0 } : {}) } }).checkboxLine + '\n<!-- crate-desc:v1:Keep%20details -->\n';
}

describe('reopening a recurring occurrence', () => {
	it.each([false, true])('preserves the final occurrence date and restores its count when recompleted (timed=%s)', timed => {
		let content = source(timed);
		content = setReminderCompletionInContent(content, read(content), true).content;
		const completed = read(content);
		expect(completed).toMatchObject({ completed: true, recurrence: { completedCount: 3 } });
		for (let repeat = 0; repeat < 3; repeat++) {
			const predicted = predictReminderCompletion(read(content), false);
			content = setReminderCompletionInContent(content, read(content), false).content;
			const reopened = read(content);
			expect(reopened).toMatchObject({ id: completed.id, dueDate: completed.dueDate, dueDatetime: completed.dueDatetime,
				description: 'Keep details', completed: false, recurrence: { count: 3, completedCount: 2 } });
			expect(predicted.recurrence).toEqual(reopened.recurrence);
			expect(setReminderCompletionInContent(content, reopened, false).content).toBe(content);
			content = setReminderCompletionInContent(content, reopened, true).content;
			expect(read(content)).toEqual(completed);
		}
	});

	it('keeps CRLF line endings when completing a recurring occurrence', () => {
		const initial = source(true, 5).replaceAll('\n', '\r\n');
		const content = setReminderCompletionInContent(initial, read(initial), true).content;
		expect(read(content).recurrence?.completedCount).toBe(5);
		expect(content.replaceAll('\r\n', '')).not.toContain('\n');
	});

	it('does not rewind an already active next occurrence or invent a negative count', () => {
		const initial = source(true, 5);
		const active = read(initial);
		expect(setReminderCompletionInContent(initial, active, false).content).toBe(initial);
		const imported = buildCreatedReminderBlock({ content: 'Imported occurrence', reminderId: 'imported', priority: 4,
			dueDate: new Date('2099-03-01T09:00:00Z'), hasTime: true,
			recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0, completedCount: 0 } }).checkboxLine.replace('[ ]', '[x]');
		const record = read(imported);
		const reopened = predictReminderCompletion(record, false);
		expect(reopened.recurrence?.completedCount).toBe(0);
		expect(reopened.dueDatetime).toBe(record.dueDatetime);
		expect(read(setReminderCompletionInContent(imported, record, false).content).recurrence?.completedCount).toBe(0);
	});
});
