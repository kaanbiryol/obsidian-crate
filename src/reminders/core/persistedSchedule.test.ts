import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import { scanReminderMarkdownContent } from './markdownScan';
import { normalizeReminderScheduleLine } from './normalizeReminderSchedule';
import { reminderRevision } from './reminderRevision';
import { UnresolvedReminderScheduleError } from '../utils/reminderParser';
import { rebuildCheckboxLine } from '../utils/checkboxParser';
import { parseReminderEditorContent } from '../utils/reminderEditorParsing';
import { calculateFirstOccurrence } from '../utils/recurrenceCalculator';
import { buildCreatedReminderBlock, buildReminderCompletionPlan } from './markdownReminderMutation';

const originalZone = process.env.TZ;
afterEach(() => { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; resetLocalTimeZone(); vi.useRealTimers(); });
function scan(content: string) { return scanReminderMarkdownContent('Reminders/Inbox.md', content, 'Reminders').reminders[0]!; }
function clock(zone: string, date: string) {
	process.env.TZ = zone; resetLocalTimeZone(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(date));
}

describe('persisted schedule decoding', () => {
    it.each([
        ['every morning', '2026-09-22T06:00:00.000Z', '2026-09-23T06:00:00.000Z'],
        ['every Monday morning', '2026-09-28T06:00:00.000Z', '2026-10-05T06:00:00.000Z'],
        ['every Thurs 09:00', '2026-09-24T09:00:00.000Z', '2026-10-01T09:00:00.000Z'],
    ])('advances everyday repeat wording after completion: %s', (schedule, first, next) => {
        clock('UTC', '2026-09-21T13:00:00Z');
        const parsed = parseReminderEditorContent(`Task ${schedule}`);
        const block = buildCreatedReminderBlock({ content: parsed.cleanContent, priority: 4,
            dueDate: undefined, recurrence: parsed.recurrence, reminderId: 'one' });
        expect(block).toMatchObject({ content: 'Task', dueDatetime: first, hasTime: true });
        const reminder = scan(block.checkboxLine);
        const completed = buildReminderCompletionPlan(reminder, true);
        expect(completed).toMatchObject({ completed: false, dueDatetime: next,
            recurrence: { ...parsed.recurrence, completedCount: 1 } });
    });

    it.each(['Compare Monday with', 'Review weekly report', 'Task every Monday'])('keeps inactive schedules literal across save and durable reload: %s', title => {
        clock('UTC', '2026-09-08T10:00:00Z');
        const input = parseReminderEditorContent(`${title} 2099-01-01`);
        const line = rebuildCheckboxLine('', false, input.cleanContent, input.dueDate, 4, undefined, input.recurrence, input.hasTime, 'one');
        expect(scan(line)).toMatchObject({ content: title, dueDate: '2099-01-01', recurrence: undefined });
    });

    it.each(['2026-02-30T09:00:00Z', '2026-13-01T09:00:00Z', '2026-02-30', 'February 30 09:00', 'February 30 at 9 in the morning', '29 February 2026 09:00'])('keeps calendar phrases that Chrono does not recognize unscheduled: %s', text => {
        const saved = scan(`- [ ] Task ${text} <!-- crate-id:one -->`);
        expect(saved).toMatchObject({ content: `Task ${text}` });
        expect(saved.dueDate).toBeUndefined();
        expect(saved.dueDatetime).toBeUndefined();
        expect(saved.recurrence).toBeUndefined();
    });

	it.each([
		['every Monday to Friday 09:00', '2026-09-09T09:00:00.000Z'],
		['every weekend 09:00', '2026-09-12T09:00:00.000Z'],
		['every weekday 09:00', '2026-09-09T09:00:00.000Z'],
		['every other Monday 09:00', '2026-09-14T09:00:00.000Z'],
		['every Tuesdays 09:00', '2026-09-15T09:00:00.000Z'],
		['every week Monday 09:00', '2026-09-14T09:00:00.000Z'],
		['weekly on Monday at 09:00', '2026-09-14T09:00:00.000Z'],
		['every Monday at noon', '2026-09-14T12:00:00.000Z'],
		['every Monday at 9 in the morning', '2026-09-14T09:00:00.000Z'],
		['daily at 3 in the afternoon', '2026-09-08T15:00:00.000Z'],
		["every 2 weeks on Mon, Wed at 9 o'clock", '2026-09-09T09:00:00.000Z'],
		['monthly on the 15th at 9.30', '2026-09-15T09:30:00.000Z'],
		['every morning', '2026-09-09T06:00:00.000Z'],
		['every Monday morning', '2026-09-14T06:00:00.000Z'],
		['every Thurs 09:00', '2026-09-10T09:00:00.000Z'],
		['daily at midnight', '2026-09-09T00:00:00.000Z'],
		['daily at 9 pm', '2026-09-08T21:00:00.000Z'],
		['monthly on the last day at 09:00', '2026-09-30T09:00:00.000Z'],
		['monthly on the 15th at 09:00', '2026-09-15T09:00:00.000Z'],
	])('preserves the editor recurrence and calculated occurrence through durable reload: %s', (schedule, dueDatetime) => {
		clock('UTC', '2026-09-08T10:00:00Z');
		const input = parseReminderEditorContent(`Task ${schedule}`);
		expect(input.recurrence).toBeDefined();
		const dueDate = calculateFirstOccurrence(input.recurrence!);
		expect(dueDate.toISOString()).toBe(dueDatetime);
		const line = rebuildCheckboxLine('', false, input.cleanContent, dueDate, input.priority,
			undefined, input.recurrence, true, 'one');
		for (const zone of ['UTC', 'Europe/Berlin', 'Pacific/Honolulu']) {
			clock(zone, '2028-04-10T23:58:00Z');
			expect(scan(line)).toMatchObject({ content: 'Task', dueDatetime, recurrence: input.recurrence });
		}
	});

	it.each([
		'[Weekly report](https://example.com/report)',
		'[Tomorrow](https://example.com/report)',
		'[Review ! #work 2099-01-01](https://example.com/report)',
	])('preserves literal editor link text %s through save and durable reload', title => {
		clock('UTC', '2026-09-08T10:00:00Z');
		for (const recurring of [false, true]) {
			const input = parseReminderEditorContent(`${title} ${recurring ? 'daily 09:00' : '2099-01-01 09:00'}`);
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

	it.each(['Jan 1, 2099', '2099-01-01 09:00'])('removes the date suffix instead of an identical earlier %s prose mention', date => {
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

it('preserves earlier project and priority tokens through a vault save and reload', () => {
    const input = parseReminderEditorContent('Compare #Home with #Work ! !');
    expect(input.cleanContent).toBe('Compare #Home with !');
    const line = rebuildCheckboxLine('', false, input.cleanContent, undefined, input.priority, input.project, undefined, false, 'one');
    const saved = scanReminderMarkdownContent('Reminders/Work.md', line, 'Reminders').reminders[0];
    expect(saved).toMatchObject({ content: 'Compare #Home with !', priority: 1, project: 'Work' });
});


it('normalizes a handwritten month-end rule using the recurrence calculator', () => {
    clock('UTC', '2026-02-01T10:00:00Z');
    const normalized = normalizeReminderScheduleLine('- [ ] Task monthly on the last day 09:00 <!-- crate-id:one -->');
    expect(scan(normalized)).toMatchObject({ content: 'Task', dueDatetime: '2026-02-28T09:00:00.000Z',
        recurrence: { frequency: 'monthly', dayOfMonth: 31, hour: 9, minute: 0 } });
});

it('changes the semantic revision when recurrence seconds change', async () => {
    const reminder = { id: 'precise', content: 'Task', priority: 4 as const, completed: false,
        recurrence: { frequency: 'daily' as const, hour: 9, minute: 0, timezone: 'UTC' } };
    const original = await reminderRevision(reminder);
    expect(await reminderRevision({ ...reminder, recurrence: { ...reminder.recurrence, second: 0, millisecond: 0 } })).toBe(original);
    expect(await reminderRevision({ ...reminder, recurrence: { ...reminder.recurrence, second: 30 } })).not.toBe(original);
    expect(await reminderRevision({ ...reminder, recurrence: { ...reminder.recurrence, millisecond: 123 } })).not.toBe(original);
});
