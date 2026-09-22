import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import * as chrono from 'chrono-node';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { buildRichTextSegments } from './richTextRenderer';
import { calculateFirstOccurrence, calculateNextOccurrence } from './recurrenceCalculator';
import { parseRecurrenceFromContent } from './recurrenceParser';
import { recurrenceToEditorText } from './rruleConverter';
import { buildReminderSubmission } from '../ui/reminder-modal/reminderMutation';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';
import { buildModalDraft } from '@/pwa/reminder-modal-draft';
import { canonicalReminderTimezone } from './reminderTimezone';

beforeEach(() => {
    vi.stubEnv('TZ', 'UTC'); resetLocalTimeZone();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T13:00:37.123Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetLocalTimeZone(); });

describe('shared schedule recognition', () => {
    it('resolves the one-off date once instead of reparsing the recognized text', () => {
        const parse = vi.spyOn(chrono.casual, 'parse');
        try {
            expect(parseReminderEditorContent('Task tomorrow 09:00 UTC')).toMatchObject({ cleanContent: 'Task', dueDate: new Date('2026-09-22T09:00Z') });
            expect(parse).toHaveBeenCalledTimes(1);
        } finally { parse.mockRestore(); }
    });

    it.each([
        ['UTC', 'UTC'], ['GMT', 'UTC'], ['utc', 'UTC'], ['(UTC)', 'UTC'],
        ['+0530', '+05:30'], ['+05:30', '+05:30'], ['GMT+5:30', '+05:30'], ['UTC-0330', '-03:30'],
        ['-00:00', 'UTC'], ['+14:00', '+14:00'], ['-12:00', '-12:00'],
        ['EST', '-05:00'], ['EDT', '-04:00'], ['IST', '+05:30'], ['NPT', '+05:45'],
        ['CET', 'Europe/Berlin'], ['ET', 'America/New_York'], ['CT', 'America/Chicago'],
        ['MT', 'America/Denver'], ['PT', 'America/Los_Angeles'],
        ['Europe/Berlin', 'Europe/Berlin'], ['europe/berlin', 'Europe/Berlin'],
        ['(America/New_York)', 'America/New_York'], ['Asia/Kolkata', 'Asia/Kolkata'],
        ['Pacific/Chatham', 'Pacific/Chatham'], ['Etc/GMT+5', 'Etc/GMT+5'],
    ])('recognizes a complete repeat with %s', (zone, expected) => {
        const schedule = `every week Monday 09:00 ${zone}`;
        const parsed = parseReminderEditorContent(`Task ${schedule}`);
        expect(parsed).toMatchObject({ cleanContent: 'Task', dueDate: undefined, dateError: undefined,
            recurrencePart: schedule, recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timezone: canonicalReminderTimezone(expected) } });
        expect(buildRichTextSegments(`Task ${schedule}`)).toEqual([
            { kind: 'text', text: 'Task ' }, { kind: 'chip', type: 'date', text: schedule },
        ]);
        expect(parseReminderEditorContent(recurrenceToEditorText(parsed.recurrence!)).recurrence).toEqual(parsed.recurrence);
    });

    it.each(['every day', 'every 2 weeks Monday, Wednesday', 'every weekend', 'monthly on the 31st'])('keeps the zone for %s', recurrence => {
        expect(parseReminderEditorContent(`Task ${recurrence} at noon America/New_York`)).toMatchObject({
            cleanContent: 'Task', dateError: undefined, recurrence: { timezone: 'America/New_York', hour: 12, minute: 0 },
        });
    });

    it.each(['+1260', '+05:60', '+14:30', '-14:30', '+15:00', '+9999', '+5::30', 'UTC+',
        'Europe/Invalid', 'America/New_York UTC', 'UTC PST', '-03:30 UTC', '+05:30foo'])('rejects malformed or conflicting zones: %s', zone => {
        for (const schedule of ['tomorrow 09:00', 'every Monday 09:00']) {
            const content = `Task Friday ${schedule} ${zone}`;
            const parsed = parseReminderEditorContent(content);
            expect(parsed).toMatchObject({ cleanContent: content, dueDate: undefined, recurrence: undefined });
            expect(parsed.dateError).toBeTypeOf('string');
            expect(buildRichTextSegments(content)).toEqual([{ kind: 'text', text: content }]);
            expect(() => buildReminderSubmission({ content, priority: 4, project: 'Inbox', projects: [], dueDate: null })).toThrow();
            expect(() => buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
                draft: { ...buildModalDraft(null, null), content } })).toThrow();
            expect(parseReminderEditorContent(`${content} Friday`)).toMatchObject({ cleanContent: content, datePart: 'Friday', dateError: undefined });
        }
    });

    it.each(['office/kitchen', 'notes/Monday.md', 'XYZ', 'ASAP', '- call Alex', '+ call Alex'])('leaves ordinary trailing text literal: %s', literal => {
        expect(parseReminderEditorContent(`Task every Monday 09:00 ${literal}`)).toMatchObject({
            cleanContent: `Task ${literal}`, dateError: undefined, recurrence: { frequency: 'weekly', timezone: 'UTC' },
        });
    });

    it.each(['in 5 minutes', 'now'])('keeps relative instants stable with a timezone suffix: %s', schedule => {
        const expected = chrono.parseDate(schedule, new Date());
        expect(parseReminderEditorContent(`Task ${schedule} Europe/Berlin`)).toMatchObject({ cleanContent: 'Task', dueDate: expected });
        expect(parseReminderEditorContent(`Task ${schedule} Europe/Berlin UTC`).dateError).toBe('Use one timezone per schedule.');
    });

    it('protects timezone-looking project names and links and keeps earlier schedules literal', () => {
        const literal = '[Europe/Invalid](https://example.com)';
        expect(parseReminderEditorContent(`Compare Monday UTC with Friday 09:00 +0530 ${literal} #Europe/Berlin`, ['Europe/Berlin']))
            .toMatchObject({ cleanContent: `Compare Monday UTC with ${literal}`, project: 'Europe/Berlin', dueDate: new Date('2026-09-25T03:30Z') });
    });

    it.each(['tomorrow morning', 'tomorrow afternoon', 'this evening', 'tonight'])('preserves Chrono’s time-of-day interpretation: %s', schedule => {
        expect(parseReminderEditorContent(`Task ${schedule}`)).toMatchObject({ cleanContent: 'Task', hasTime: true,
            dueDate: chrono.parseDate(schedule, new Date(), { forwardDate: true }) });
    });

    it.each([
        ['2026-03-28T23:30Z', 'tomorrow 09:00 Europe/Berlin', '2026-03-30T07:00Z'],
        ['2026-03-28T23:30Z', 'tomorrow 09:00 America/New_York', '2026-03-29T13:00Z'],
        ['2026-10-24T12:00Z', 'tomorrow 09:00 Europe/Berlin', '2026-10-25T08:00Z'],
        ['2026-09-21T23:30Z', 'tomorrow 09:00 Asia/Tokyo', '2026-09-23T00:00Z'],
    ])('resolves one-off IANA dates in the target zone at %s', (now, schedule, expected) => {
        vi.setSystemTime(new Date(now));
        expect(parseReminderEditorContent(`Task ${schedule}`)).toMatchObject({ cleanContent: 'Task', hasTime: true, dueDate: new Date(expected) });
    });
});

describe('recurrence timezone calculations', () => {
    it.each([
        ['daily 09:00 Europe/Berlin', '2026-03-28T08:00Z', '2026-03-29T07:00Z'],
        ['daily 09:00 Europe/Berlin', '2026-10-24T07:00Z', '2026-10-25T08:00Z'],
        ['every week Monday 09:00 America/New_York', '2026-03-02T14:00Z', '2026-03-09T13:00Z'],
        ['every 2 weeks Monday 09:00 America/New_York', '2026-10-26T13:00Z', '2026-11-09T14:00Z'],
        ['monthly on the 31st 09:00 Europe/Berlin', '2026-03-31T07:00Z', '2026-04-30T07:00Z'],
        ['monthly on the 31st 09:00 +05:30', '2028-01-31T03:30Z', '2028-02-29T03:30Z'],
        ['every Monday 00:30 +14:00', '2026-09-20T10:30Z', '2026-09-27T10:30Z'],
        ['daily 23:30 -03:30', '2026-09-22T03:00Z', '2026-09-23T03:00Z'],
        ['daily 02:30 Europe/Berlin', '2026-03-28T01:30Z', '2026-03-29T01:30Z'],
        ['daily 02:30 Europe/Berlin', '2026-03-29T01:30Z', '2026-03-30T00:30Z'],
        ['daily 02:30 Europe/Berlin', '2026-10-24T00:30Z', '2026-10-25T00:30Z'],
        ['daily 09:00 +01:00', '2026-03-28T08:00Z', '2026-03-29T08:00Z'],
        ['daily 09:00 Australia/Sydney', '2026-10-02T23:00Z', '2026-10-03T22:00Z'],
        ['daily 02:15 Australia/Lord_Howe', '2026-10-02T15:45Z', '2026-10-03T15:45Z'],
        ['daily 09:00 Pacific/Chatham', '2026-09-25T20:15Z', '2026-09-26T19:15Z'],
    ])('advances %s across calendar/offset boundaries', (schedule, current, next) => {
        const rule = parseRecurrenceFromContent(schedule)!.rule;
        expect(calculateNextOccurrence(new Date(current), rule)).toEqual(new Date(next));
    });

    it.each(['CET', 'ET', 'CT', 'MT', 'PT', 'EST', 'EDT', 'IST'])('matches Chrono in winter and summer for %s', zone => {
        for (const date of ['2026-01-15', '2026-07-15']) {
            vi.setSystemTime(new Date(`${date}T00:00Z`));
            const rule = parseRecurrenceFromContent(`daily 09:00 ${zone}`)!.rule;
            expect(calculateFirstOccurrence(rule)).toEqual(chrono.parseDate(`${date} 09:00 ${zone}`));
        }
    });

    it('checks recurrence limits against the target calendar day and completion count', () => {
        const rule = { ...parseRecurrenceFromContent('every Monday 00:30 +14:00')!.rule, endDate: '2026-09-28', count: 3 };
        // Both occurrences fall on Sunday in UTC and Monday in the rule's zone.
        expect(calculateNextOccurrence(new Date('2026-09-20T10:30Z'), rule, 1)).toEqual(new Date('2026-09-27T10:30Z'));
        expect(calculateNextOccurrence(new Date('2026-09-27T10:30Z'), rule, 1)).toBeNull();
        expect(calculateNextOccurrence(new Date('2026-09-20T10:30Z'), rule, 2)).toBeNull();
    });
});
