import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { formatReminderDateText } from './reminderDate';
import { parseReminderEditorContent } from './reminderEditorParsing';

describe('fixed reminder date text', () => {
	it('preserves the existing date and 24-hour editor syntax across months and times', () => {
		for (const year of [1, 99, 2024, 2026]) {
			for (let month = 0; month < 12; month++) {
				for (const hour of [0, 9, 12, 23]) {
					const date = new Date(2026, month, 15, hour, 5);
					date.setFullYear(year);
					expect(formatReminderDateText(date)).toBe(format(date, 'MMM d, yyyy'));
					expect(formatReminderDateText(date, true)).toBe(format(date, 'MMM d, yyyy HH:mm'));
				}
			}
		}
	});

	it('round-trips midnight, leap day, and daylight-saving transition dates through the editor parser', () => {
		for (const date of [new Date(2028, 1, 29, 0, 0), new Date(2027, 2, 28, 3, 15), new Date(2027, 9, 31, 1, 30)]) {
			const parsed = parseReminderEditorContent(`Task ${formatReminderDateText(date, true)}`, ['Inbox']);
			expect(parsed.cleanContent).toBe('Task');
			expect(parsed.hasTime).toBe(true);
			expect(parsed.dueDate?.getTime()).toBe(date.getTime());
		}
	});

	it('rejects invalid dates instead of writing invalid reminder text', () => {
		expect(() => formatReminderDateText(new Date('invalid'))).toThrow(RangeError);
	});
});
