import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import { scanReminderMarkdownContent } from './markdownScan';
import { normalizeReminderScheduleLine } from './normalizeReminderSchedule';
import { reminderRevision } from './reminderRevision';
import { UnresolvedReminderScheduleError } from '../utils/reminderParser';
import { rebuildCheckboxLine } from '../utils/checkboxParser';
import { parseReminderEditorContent } from '../utils/reminderEditorParsing';

const originalZone = process.env.TZ;
afterEach(() => { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; resetLocalTimeZone(); vi.useRealTimers(); });
function scan(content: string) { return scanReminderMarkdownContent('Reminders/Inbox.md', content, 'Reminders').reminders[0]!; }
function clock(zone: string, date: string) {
	process.env.TZ = zone; resetLocalTimeZone(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(date));
}

describe('persisted schedule decoding', () => {
	it.each([
		'[Weekly report](https://example.com/report)',
		'[Tomorrow](https://example.com/report)',
		'[Review ! #work 2099-01-01](https://example.com/report)',
	])('preserves literal editor link text %s through save and durable reload', title => {
		clock('UTC', '2026-09-08T10:00:00Z');
		for (const recurring of [false, true]) {
			const input = parseReminderEditorContent(`${title} ${recurring ? 'daily 09:00' : '2099-01-01T09:00:00Z'}`);
			expect(input.cleanContent).toBe(title);
			const line = rebuildCheckboxLine('', false, input.cleanContent, new Date('2099-01-01T09:00:00Z'), input.priority,
				undefined, input.recurrence, true, 'one');
			const saved = scan(line);
			expect(saved.content).toBe(title);
			expect(saved.priority).toBe(4);
			expect(saved.dueDatetime).toBe('2099-01-01T09:00:00.000Z');
			expect(saved.recurrence).toEqual(input.recurrence);
		}
	});

	it.each(['Jan 1, 2099', '2099-01-01T09:00:00.000Z'])('removes the date suffix instead of an identical earlier %s prose mention', date => {
		clock('UTC', '2026-09-08T10:00:00Z');
		const input = parseReminderEditorContent(`Compare ${date} against the old report ${date}`);
		expect(input.cleanContent).toBe(`Compare ${date} against the old report`);
		const line = rebuildCheckboxLine('', false, input.cleanContent, input.dueDate, 4, undefined, undefined, input.hasTime, 'one');
		expect(scan(line).content).toBe(input.cleanContent);
	});

	it('uses the appended recurrence and preserves earlier recurrence prose', () => {
		const line = rebuildCheckboxLine('', false, 'Daily report', new Date('2099-01-01T09:00:00Z'), 4, undefined,
			{ frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0 }, true, 'one');
		expect(scan(line)).toMatchObject({ content: 'Daily report', recurrence: { frequency: 'daily', hour: 9, minute: 0 } });
	});

	it.each(['tomorrow', 'next Friday', 'Sep 9', '2026-09-10T09:00', 'daily', 'every Friday 12:00'])('does not infer a durable schedule from %s', schedule => {
		for (const date of ['2026-09-08T10:00:00Z', '2026-09-09T10:00:00Z']) {
			clock('UTC', date);
			expect(() => scan(`- [ ] Task ${schedule} <!-- crate-id:one -->`)).toThrow(UnresolvedReminderScheduleError);
		}
	});

	it.each(['2026-09-10', 'Sep 10, 2026', '2026-09-10T00:30:00.000Z', '2026-09-10T01:30:00+03:00'])('decodes %s identically across clocks and host timezones', async schedule => {
		clock('UTC', '2026-09-08T10:00:00Z');
		const content = `- [ ] Task ${schedule} <!-- crate-id:one -->`;
		const original = scan(content);
		for (const zone of ['Europe/Berlin', 'Pacific/Honolulu', 'Asia/Tokyo']) {
			clock(zone, '2028-02-27T23:58:00Z');
			expect(scan(content)).toEqual(original);
			expect(await reminderRevision(scan(content))).toBe(await reminderRevision(original));
		}
	});

	it.each(['tomorrow', 'tomorrow at 09:00', '2026-09-10T09:00', 'every Friday 12:00', 'daily'])('resolves %s once while retaining title, identity, and description', schedule => {
		clock('Europe/Berlin', '2026-09-08T10:00:00Z');
		const line = `- [ ] **Task** ${schedule} ! <!-- crate-id:one -->`;
		const normalized = normalizeReminderScheduleLine(line);
		const content = `${normalized}\n<!-- crate-desc:v1:Keep%20these%20details -->`;
		const original = scan(content);
		expect(original).toMatchObject({ id: 'one', content: '**Task**', description: 'Keep these details', priority: 1 });
		for (const zone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
			clock(zone, '2028-04-10T23:58:00Z');
			expect(normalizeReminderScheduleLine(normalized)).toBe(normalized);
			expect(scan(content)).toEqual(original);
		}
	});

	it('does not interpret unadopted checkboxes during durable reads', () => {
		expect(scanReminderMarkdownContent('Notes.md', '- [ ] Call tomorrow', '').reminders).toEqual([]);
	});

	it.each(['weekly', 'daily 12:00'])('requires fresh metadata after the readable rule changes to %s', readableRule => {
		const original = rebuildCheckboxLine('', false, 'Task', new Date('2026-09-09T10:00:00Z'), 4, undefined,
			{ frequency: 'daily', timezone: 'Pacific/Honolulu' }, true, 'one');
		const edited = original.replace('daily', readableRule);
		for (const zone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
			clock(zone, '2026-09-08T10:00:00Z');
			expect(() => scan(edited)).toThrow(UnresolvedReminderScheduleError);
		}
		clock('Europe/Berlin', '2026-09-08T10:00:00Z');
		const normalized = normalizeReminderScheduleLine(edited);
		const adopted = scan(normalized);
		expect(adopted.recurrence?.timezone).toBe('Europe/Berlin');
		for (const zone of ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo']) {
			clock(zone, '2028-04-10T23:58:00Z');
			expect(scan(normalized)).toEqual(adopted);
		}
	});
});
