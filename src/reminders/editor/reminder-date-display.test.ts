import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderDateDisplay, reminderLineDisplays } from './reminder-date-display';
import { formatDueDate } from '../ui/format/dateFormatting';
import { parseReminderContent } from '../core/grammar/reminderParser';

const now = new Date('2026-11-14T12:00:00.000Z');
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

const display = (text: string) => reminderDateDisplay(text, now);
const covered = (text: string) => {
	const found = display(text);
	return found && { kind: found.kind, text: text.slice(found.from, found.to) };
};

describe('saved reminder dates', () => {
	it('shows a stored instant as a chip in local time', () => {
		const text = '- [ ] Book a table for 2026-11-20T09:30:00.000Z <!-- crate-id:a -->';
		expect(covered(text)).toEqual({ kind: 'chip', text: '2026-11-20T09:30:00.000Z' });
		expect(display(text)).toMatchObject({ label: formatDueDate('2026-11-20T09:30:00.000Z', undefined, now), overdue: false });
	});

	it('shows a stored all-day date as a chip', () => {
		expect(covered('- [ ] Pay rent 2026-12-01')).toEqual({ kind: 'chip', text: '2026-12-01' });
	});

	it('marks past dates overdue unless the reminder is done', () => {
		expect(display('- [ ] Call Mia 2026-10-05T09:00:00.000Z')).toMatchObject({ overdue: true });
		expect(display('- [x] Call Mia 2026-10-05T09:00:00.000Z')).toMatchObject({ overdue: false });
	});

	it('covers the schedule, not an earlier identical date in the title', () => {
		const text = '- [ ] Move 2026-12-01 notes 2026-12-01';
		expect(display(text)?.from).toBe(text.lastIndexOf('2026-12-01'));
	});

	it('leaves plain lines and tasks without a schedule alone', () => {
		expect(display('Meeting on 2026-12-01')).toBeNull();
		expect(display('- [ ] Buy milk')).toBeNull();
	});
});

describe('typed reminder dates', () => {
	it('underlines a natural-language date with the date saving will write', () => {
		const text = '- [ ] Book a table next thursday 9am';
		expect(covered(text)).toEqual({ kind: 'phrase', text: 'next thursday 9am' });
		const saved = new Date(now);
		saved.setDate(saved.getDate() + ((4 - saved.getDay() + 7) % 7 || 7));
		saved.setHours(9, 0, 0, 0);
		expect(display(text)).toMatchObject({ label: formatDueDate(saved.toISOString(), undefined, now) });
	});

	it('underlines a repeat phrase', () => {
		expect(covered('- [ ] Water plants every monday')).toEqual({ kind: 'phrase', text: 'every monday' });
	});

	it.each([
		['Pay rent tomorrow 09:00+25:00', '09:00+25:00'],
		['Water plants every 0 days', 'every 0 days'],
	])('marks a schedule that cannot be saved with the error the reminder editor shows: %s', (content, phrase) => {
		const text = `- [ ] ${content}`;
		expect(covered(text)).toEqual({ kind: 'error', text: phrase });
		expect(display(text)).toMatchObject({ message: parseReminderContent(content).dateError });
	});

	it('finds the phrase the reminder editor parses, not the first match in the line', () => {
		const text = '- [ ] Move tomorrow lunch to friday';
		expect(covered(text)).toEqual({ kind: 'phrase', text: parseReminderContent('Move tomorrow lunch to friday').datePart });
	});
});

describe('typed descriptions', () => {
	it('takes the schedule from the title and marks the description', () => {
		const text = '- [ ] Call Mia 2026-12-24 // before friday <!-- crate-id:a -->';
		expect(reminderLineDisplays(text, now).map(found => `${found.kind}:${text.slice(found.from, found.to)}`))
			.toEqual(['chip:2026-12-24', 'description: // before friday']);
		expect(covered('- [ ] Call Mia // before friday')).toBeNull();
	});
});
