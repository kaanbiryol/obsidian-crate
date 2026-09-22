import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { calculateFirstOccurrence, calculateNextOccurrence } from './recurrenceCalculator';
import { buildRichTextSegments } from './richTextRenderer';
import { buildReminderSubmission } from '../ui/reminder-modal/reminderMutation';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 21, 13)); });
afterEach(() => vi.useRealTimers());

function submitInBothEditors(content: string) {
    return [
        () => buildReminderSubmission({ content, projects: [], project: 'Inbox', priority: 4, dueDate: null }),
        () => buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
            draft: { content, description: '', project: 'Inbox', defaultProject: 'Inbox', priority: 4,
                dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } }),
    ];
}

describe('complete reminder schedules', () => {
    it.each([
        ['Take vitamins', 'every morning', { frequency: 'daily', hour: 6, minute: 0 }],
        ['Call Alex', 'every Monday morning', { frequency: 'weekly', daysOfWeek: [1], hour: 6, minute: 0 }],
        ['Gym', 'every Thurs 09:00', { frequency: 'weekly', daysOfWeek: [4], hour: 9, minute: 0 }],
        ['Gym', 'every Thur 09:00', { frequency: 'weekly', daysOfWeek: [4], hour: 9, minute: 0 }],
        ['Take vitamins', 'every other morning', { frequency: 'daily', interval: 2, hour: 6, minute: 0 }],
        ['Take vitamins', 'every morning at 09:30', { frequency: 'daily', hour: 9, minute: 30 }],
        ['Call Alex', 'every week Monday in the morning', { frequency: 'weekly', daysOfWeek: [1], hour: 6, minute: 0 }],
        ['Call Alex', 'every Monday morning at 09:30 UTC', { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 30, timezone: 'UTC' }],
        ['Call Alex', 'every Monday evening at 9', { frequency: 'weekly', daysOfWeek: [1], hour: 21, minute: 0 }],
        ['Take vitamins', 'daily in the afternoon', { frequency: 'daily', hour: 15, minute: 0 }],
        ['Take vitamins', 'every evening', { frequency: 'daily', hour: 20, minute: 0 }],
        ['Take vitamins', 'every night', { frequency: 'daily', hour: 20, minute: 0 }],
        ['Take vitamins', 'daily at night', { frequency: 'daily', hour: 20, minute: 0 }],
        ['Take vitamins', 'every midday', { frequency: 'daily', hour: 12, minute: 0 }],
    ])('preserves an everyday repeat through highlighting and both saves: %s %s', (title, schedule, recurrence) => {
        const content = `${title} ${schedule}`;
        expect(parseReminderEditorContent(content)).toMatchObject({
            cleanContent: title, recurrencePart: schedule, recurrence, dueDate: undefined, dateError: undefined,
        });
        expect(buildRichTextSegments(content)).toEqual([
            { kind: 'text', text: `${title} ` }, { kind: 'chip', type: 'date', text: schedule },
        ]);
        for (const submit of submitInBothEditors(content)) expect(submit()).toMatchObject({ content: title, recurrence });
    });

    it.each([
        'every two weeks', 'every two weeks Monday 09:00', 'every two weeks on Monday morning',
        'every two days 09:00', 'every twenty-one days 09:00', 'every two Mondays morning',
        'every two months on the 15th at noon', 'every twenty\u00a0one days 09:00',
        'every two mornings at 09:00',
    ])('blocks unsupported repeat wording without scheduling just its date or time: %s', schedule => {
        const content = `Task ${schedule}`;
        const parsed = parseReminderEditorContent(content);
        expect(parsed).toMatchObject({ cleanContent: content.replace(/\s+/g, ' '), recurrence: undefined, dueDate: undefined });
        expect(parsed.dateError).toBeTruthy();
        expect(buildRichTextSegments(content)).toEqual([{ kind: 'text', text: content }]);
        for (const submit of submitInBothEditors(content)) expect(submit).toThrow(parsed.dateError);
    });

    it.each(['Check every item', 'Review every two pages', 'Call every customer'])('leaves ordinary uses of every as title text: %s', content => {
        expect(parseReminderEditorContent(content)).toMatchObject({ cleanContent: content, recurrence: undefined, dueDate: undefined, dateError: undefined });
        for (const submit of submitInBothEditors(content)) expect(submit()).toMatchObject({ content });
    });

    it('keeps a later schedule authoritative after unsupported repeat wording', () => {
        expect(parseReminderEditorContent('Task every two weeks Monday 09:00 then Friday')).toMatchObject({
            cleanContent: 'Task every two weeks Monday 09:00 then', datePart: 'Friday',
            dueDate: new Date(2026, 8, 25), recurrence: undefined, dateError: undefined,
        });
    });

    it('protects repeat-like project names and links from the unsupported-wording guard', () => {
        const content = 'Read [every two weeks](https://example.com) #Every two weeks';
        expect(parseReminderEditorContent(content, ['Every two weeks'])).toMatchObject({
            cleanContent: 'Read [every two weeks](https://example.com)', project: 'Every two weeks',
            recurrence: undefined, dueDate: undefined, dateError: undefined,
        });
    });

    it('keeps the literal @ prefix when consuming a following date', () => {
        for (const submit of submitInBothEditors('Task @tomorrow')) expect(submit()).toMatchObject({ content: 'Task @' });
    });

    it.each([
        'monday@example.com', 'sales@friday.com', 'monday+notes@example.com', 'weekly@localhost',
        'monday.com', 'monday.com:8080/tasks', 'Monday.md', 'weekly.csv', '2027-2-30.md', '31.04.2027.pdf',
        '/notes/Monday.md', 'notes/Monday', '../Friday', '~/Monday.md', 'C:\\notes\\Monday.md', 'notes\\Friday',
        '(monday.com)', '"Monday.md"',
    ])('preserves a literal address or filename through recognition and saving: %s', literal => {
        const content = `Review ${literal}`;
        const parsed = parseReminderEditorContent(content);
        expect(parsed.cleanContent).toBe(content);
        expect(parsed.dueDate).toBeUndefined();
        expect(parsed.recurrence).toBeUndefined();
        expect(parsed.dateError).toBeUndefined();
        expect(buildRichTextSegments(content)).toEqual([{ kind: 'text', text: content }]);
        for (const submit of submitInBothEditors(content)) expect(submit()).toMatchObject({ content });
        const scheduled = `${content} Friday 09:00`;
        expect(parseReminderEditorContent(scheduled)).toMatchObject({ cleanContent: content, datePart: 'Friday 09:00', dueDate: new Date(2026, 8, 25, 9) });
        for (const submit of submitInBothEditors(scheduled)) expect(submit()).toMatchObject({ content });
    });

    it.each(['Version 1.2.3', 'Version 1.2.34', 'Value 9.00', 'Range 2-30'])('leaves non-date numeric text alone: %s', content => {
        const parsed = parseReminderEditorContent(content);
        expect(parsed.cleanContent).toBe(content);
        expect(parsed.dueDate).toBeUndefined();
        expect(parsed.dateError).toBeUndefined();
    });

    it.each([
        ['every Monday to Friday 09:00', [1, 2, 3, 4, 5], undefined],
        ['every week Mon-Fri 09:00', [1, 2, 3, 4, 5], undefined],
        ['every weekend 09:00', [0, 6], undefined],
        ['every weekday and Saturday 09:00', [1, 2, 3, 4, 5, 6], undefined],
        ['every weekday 09:00', [1, 2, 3, 4, 5], undefined],
        ['every other Monday 09:00', [1], 2],
        ['every Tuesdays 09:00', [2], undefined],
    ] as const)('keeps %s recurring in highlighting and both submission paths', (schedule, daysOfWeek, interval) => {
        const text = `Task ${schedule}`;
        const recurrence = { frequency: 'weekly', daysOfWeek: [...daysOfWeek], ...(interval ? { interval } : {}), hour: 9, minute: 0 };
        expect(parseReminderEditorContent(text)).toMatchObject({ cleanContent: 'Task', recurrence, dueDate: undefined, dateError: undefined });
        expect(buildRichTextSegments(text)).toEqual([
            { kind: 'text', text: 'Task ' }, { kind: 'chip', type: 'date', text: schedule },
        ]);
        for (const submit of submitInBothEditors(text)) expect(submit()).toMatchObject({ content: 'Task', recurrence });
    });

    it.each(['2026-09-28 09:00', '2026-09-28 at 09:00', '2026-09-28 at 9am'])('combines a calendar date and local time: %s', schedule => {
        const parsed = parseReminderEditorContent(`Task ${schedule}`);
        expect(parsed).toMatchObject({ cleanContent: 'Task', datePart: schedule, hasTime: true, dueDate: new Date(2026, 8, 28, 9) });
        expect(buildRichTextSegments(`Task ${schedule}`)).toEqual([
            { kind: 'text', text: 'Task ' }, { kind: 'chip', type: 'date', text: schedule },
        ]);
    });

    it.each(['to', 'through', 'until', '-', '–'])('uses the final weekday and preserves the earlier range text: %s', connector => {
        const text = `Compare Monday ${connector} Friday`;
        expect(parseReminderEditorContent(text)).toMatchObject({
            cleanContent: `Compare Monday ${connector}`, datePart: 'Friday', dueDate: new Date(2026, 8, 25),
        });
        expect(buildRichTextSegments(text)).toEqual([
            { kind: 'text', text: `Compare Monday ${connector} ` }, { kind: 'chip', type: 'date', text: 'Friday' },
        ]);
    });

    it('keeps the last-token rule after a user removes the final date', () => {
        expect(parseReminderEditorContent('Compare Monday with Friday')).toMatchObject({ cleanContent: 'Compare Monday with', datePart: 'Friday' });
        expect(parseReminderEditorContent('Compare Monday with ')).toMatchObject({ cleanContent: 'Compare with', datePart: 'Monday' });
    });

    it.each([
        'every 0 days', 'every -1 days', 'every 1.5 days', 'every 0 weeks', 'monthly on the 32nd',
        'every other weekday 09:00', 'every 0 Mondays 09:00',
        'every other weekend 09:00',
    ])('rejects the malformed schedule without falling back to an earlier date: %s', schedule => {
        const text = `Task Monday ${schedule}`;
        const parsed = parseReminderEditorContent(text);
        expect(parsed.dateError).toBeTruthy();
        expect(parsed).toMatchObject({ cleanContent: text, dueDate: undefined, recurrence: undefined });
        expect(buildRichTextSegments(text)).toEqual([{ kind: 'text', text }]);
        for (const submit of submitInBothEditors(text)) expect(submit).toThrow(parsed.dateError);
    });

    it('allows a later valid schedule to supersede an invalid earlier mention', () => {
        expect(parseReminderEditorContent('Task daily 09:00:30 Friday')).toMatchObject({
            cleanContent: 'Task daily 09:00:30', datePart: 'Friday', dueDate: new Date(2026, 8, 25), dateError: undefined,
        });
        expect(parseReminderEditorContent('Task February 30 09:00 Friday')).toMatchObject({
            cleanContent: 'Task February 30 09:00', datePart: 'Friday', dateError: undefined,
        });
        expect(parseReminderEditorContent('Task 02/30/2027 09:00 Friday')).toMatchObject({
            cleanContent: 'Task 02/30/2027 09:00', datePart: 'Friday', dateError: undefined,
        });
    });

    it.each(['February 29, 2028 09:00', 'February 29,2028 09:00', 'February 29,24', 'February 29-2028', '29 February 2028 09:00', 'February 29, 2000', 'April 30', 'June 2026', 'May 09:00'])('does not reject valid dates or mistake a clock/year for a day: %s', schedule => {
        const parsed = parseReminderEditorContent(`Task ${schedule}`);
        expect(parsed.dateError).toBeUndefined();
        expect(parsed.dueDate).toBeInstanceOf(Date);
    });

    it('keeps invalid-looking dates inside links and known projects literal', () => {
        const parsed = parseReminderEditorContent('Read [February 30](https://example.com/30-February) #February 30', ['February 30']);
        expect(parsed).toMatchObject({ cleanContent: 'Read [February 30](https://example.com/30-February)', project: 'February 30', dueDate: undefined });
        expect(parsed.dateError).toBeUndefined();
        const slash = parseReminderEditorContent('Read [02/30/2027](https://example.com/02/30/2027) #Archive/02/30/2027');
        expect(slash).toMatchObject({
            cleanContent: 'Read [02/30/2027](https://example.com/02/30/2027)', project: 'Archive/02/30/2027', dueDate: undefined,
        });
        expect(slash.dateError).toBeUndefined();
    });

    it.each([
        ['02/28/2027', 2027, 2, 28], ['28/02/2027', 2027, 2, 28], ['2027/02/28', 2027, 2, 28],
        ['02/29/2028', 2028, 2, 29], ['02/29/28', 2028, 2, 29], ['29/02/2000', 2000, 2, 29],
        ['04/05/2027', 2027, 4, 5], ['12/31/2027', 2027, 12, 31], ['31/12/2027', 2027, 12, 31],
        ['30.04.2027', 2027, 4, 30], ['04-30-2027', 2027, 4, 30], ['2027-2-28', 2027, 2, 28],
        ['2028.2.29', 2028, 2, 29], ['2028-2-29', 2028, 2, 29], ['30.04.27', 2027, 4, 30],
    ])('preserves supported numeric-date interpretation: %s', (date, year, month, day) => {
        const parsed = parseReminderEditorContent(`Task ${date} 09:00`);
        expect(parsed).toMatchObject({ cleanContent: 'Task', dueDate: new Date(Number(year), Number(month) - 1, Number(day), 9), hasTime: true, dateError: undefined });
        for (const submit of submitInBothEditors(`Task ${date} 09:00`)) expect(submit()).toMatchObject({ content: 'Task' });
    });
});


it.each([
    ['2026-02-01T13:00:00Z', '2026-02-28T09:00:00Z', '2026-03-31T09:00:00Z'],
    ['2028-02-01T13:00:00Z', '2028-02-29T09:00:00Z', '2028-03-31T09:00:00Z'],
    ['2026-04-01T13:00:00Z', '2026-04-30T09:00:00Z', '2026-05-31T09:00:00Z'],
])('schedules the last day of the month from %s', (now, first, next) => {
    vi.setSystemTime(new Date(now));
    const parsed = parseReminderEditorContent('Task monthly on the last day 09:00');
    expect(parsed).toMatchObject({ cleanContent: 'Task', dateError: undefined, recurrence: { frequency: 'monthly', dayOfMonth: 31, hour: 9, minute: 0 } });
    const rule = { ...parsed.recurrence!, timezone: 'UTC' };
    const occurrence = calculateFirstOccurrence(rule);
    expect(occurrence).toEqual(new Date(first));
    expect(calculateNextOccurrence(occurrence, rule)).toEqual(new Date(next));
});

it('skips weekends for every weekday and skips a week for every other Monday', () => {
    vi.setSystemTime(new Date('2026-09-25T13:00:00Z'));
    const weekdayRule = { ...parseReminderEditorContent('Task every weekday 09:00').recurrence!, timezone: 'UTC' };
    const firstWeekday = calculateFirstOccurrence(weekdayRule);
    expect(firstWeekday).toEqual(new Date('2026-09-28T09:00:00Z'));
    expect(calculateNextOccurrence(firstWeekday, weekdayRule)).toEqual(new Date('2026-09-29T09:00:00Z'));
    const alternateMondayRule = { ...parseReminderEditorContent('Task every other Monday 09:00').recurrence!, timezone: 'UTC' };
    const firstMonday = calculateFirstOccurrence(alternateMondayRule);
    expect(firstMonday).toEqual(new Date('2026-09-28T09:00:00Z'));
    expect(calculateNextOccurrence(firstMonday, alternateMondayRule)).toEqual(new Date('2026-10-12T09:00:00Z'));
});

it('repeats on both weekend days and returns to the following weekend', () => {
    vi.setSystemTime(new Date('2026-09-25T13:00:00Z'));
    const rule = { ...parseReminderEditorContent('Task every weekend 09:00').recurrence!, timezone: 'UTC' };
    const saturday = calculateFirstOccurrence(rule);
    expect(saturday).toEqual(new Date('2026-09-26T09:00:00Z'));
    const sunday = calculateNextOccurrence(saturday, rule)!;
    expect(sunday).toEqual(new Date('2026-09-27T09:00:00Z'));
    expect(calculateNextOccurrence(sunday, rule)).toEqual(new Date('2026-10-03T09:00:00Z'));
});
