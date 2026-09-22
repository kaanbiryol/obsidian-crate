import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import * as chrono from 'chrono-node';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { buildRichTextSegments } from './richTextRenderer';
import { buildReminderSubmission } from '../ui/reminder-modal/reminderMutation';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';
import { buildModalDraft } from '@/pwa/reminder-modal-draft';
import { calculateFirstOccurrence, calculateNextOccurrence } from './recurrenceCalculator';

beforeEach(() => {
    vi.stubEnv('TZ', 'UTC'); resetLocalTimeZone();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T13:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetLocalTimeZone(); });

describe.each([
    ['every Monday', { frequency: 'weekly', daysOfWeek: [1] }],
    ['daily', { frequency: 'daily' }],
    ['every 2 weeks on Mon, Wed', { frequency: 'weekly', interval: 2, daysOfWeek: [1, 3] }],
    ['monthly on the 15th', { frequency: 'monthly', dayOfMonth: 15 }],
] as const)('Chrono time wording after %s', (cadence, fields) => {
    it.each([
        'at 9 in the morning', '9 in the morning', 'at 3 in the afternoon', '8 at night',
        "at 9 o'clock", 'at 9 o’clock', 'at 9.30', 'at 9 p', '09',
        'at 9am', 'at 9a.m.', 'at 9 a.m.', 'at 09:30 p.m.', 'at noon', 'midday', 'morning',
        'morning at 09:30', 'evening at 9', 'at 00:00', '23:59',
        'at 09:00:30', 'at 09:00:30.123', 'at 09:00:30 in the morning', 'morning at 09:00:30',
    ])('uses the same complete time as a one-off: %s', time => {
        const oneOff = chrono.parse(`Monday ${time}`, new Date(), { forwardDate: true })[0]!;
        expect(oneOff.text).toBe(`Monday ${time}`);
        expect(parseReminderEditorContent(`Call Alex Monday ${time}`)).toMatchObject({
            cleanContent: 'Call Alex', hasTime: true, dueDate: oneOff.start.date(), dateError: undefined,
        });
        const recurrence = { ...fields, hour: oneOff.start.get('hour'), minute: oneOff.start.get('minute'), timezone: 'UTC',
            ...(oneOff.start.get('second') ? { second: oneOff.start.get('second') } : {}),
            ...(oneOff.start.get('millisecond') ? { millisecond: oneOff.start.get('millisecond') } : {}) };
        const schedule = `${cadence} ${time}`;
        const content = `Call Alex ${schedule}`;
        expect(parseReminderEditorContent(content)).toMatchObject({
            cleanContent: 'Call Alex', recurrencePart: schedule, recurrence, dueDate: undefined, dateError: undefined,
        });
        expect(buildRichTextSegments(content)).toEqual([
            { kind: 'text', text: 'Call Alex ' }, { kind: 'chip', type: 'date', text: schedule },
        ]);
        expect(buildReminderSubmission({ content, priority: 4, project: 'Inbox', projects: [], dueDate: null }))
            .toMatchObject({ content: 'Call Alex', recurrence });
        expect(buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
            draft: { ...buildModalDraft(null, null), content } })).toMatchObject({ content: 'Call Alex', recurrence });
    });
});

it('keeps Monday and 09:00 through the first and following occurrences', () => {
    const rule = parseReminderEditorContent('Call Alex every Monday at 9 in the morning').recurrence!;
    const first = calculateFirstOccurrence(rule);
    expect(first.toISOString()).toBe('2026-09-28T09:00:00.000Z');
    expect(calculateNextOccurrence(first, rule)?.toISOString()).toBe('2026-10-05T09:00:00.000Z');
});

it.each(['9'])('leaves a bare hour as text just as Chrono does: %s', hour => {
    expect(chrono.parse(`Monday ${hour}`)[0]?.text).toBe('Monday');
    const parsed = parseReminderEditorContent(`Call Alex every Monday ${hour}`);
    expect(parsed).toMatchObject({ cleanContent: `Call Alex ${hour}`, recurrencePart: 'every Monday',
        recurrence: { frequency: 'weekly', daysOfWeek: [1] }, dateError: undefined });
    expect(parsed.recurrence?.hour).toBeUndefined();
});

it.each(['Mon.', 'Thurs.', 'Thu.'])('keeps Chrono weekday abbreviations attached to their time: %s', day => {
    const oneOff = chrono.parse(`${day} at 9 in the morning`)[0]!;
    expect(parseReminderEditorContent(`Task every ${day} at 9 in the morning`)).toMatchObject({
        cleanContent: 'Task', recurrence: { frequency: 'weekly', daysOfWeek: [oneOff.start.get('weekday')], hour: 9, minute: 0 },
    });
});

it.each(['UTC', 'CET', 'America/New_York', '+05:30', '-03:30'])('retains a timezone after a complete Chrono time: %s', zone => {
    const content = `Call Alex every Monday at 9 in the morning ${zone}`;
    const ordinary = parseReminderEditorContent(`Task every Monday 09:00 ${zone}`).recurrence;
    expect(parseReminderEditorContent(content)).toMatchObject({ cleanContent: 'Call Alex', recurrence: ordinary, dateError: undefined });
});

it.each([
    ['25:00', 'every Monday', '25:00', undefined],
    ['at 25', 'every Monday', 'at 25', undefined],
    ['13pm', 'every Monday', '13pm', undefined],
    ['09:60', 'every Monday', '09:60', undefined],
    ['09:001', 'every Monday 09', ':001', 9],
    ['09:00UTC', 'every Monday 09', ':00UTC', 9],
    ['morning 25:00', 'every Monday morning', '25:00', 6],
] as const)('leaves time text that Chrono does not consume: %s', (time, recurrencePart, suffix, hour) => {
    const parsed = parseReminderEditorContent(`Task every Monday ${time}`);
    expect(parsed).toMatchObject({ cleanContent: `Task ${suffix}`, recurrencePart, dateError: undefined,
        recurrence: { frequency: 'weekly', daysOfWeek: [1] } });
    expect(parsed.recurrence?.hour).toBe(hour);
    expect(parsed.dueDate).toBeUndefined();
});

it.each(['tomorrow 09:00', 'Friday at 9 in the morning', 'in 5 minutes'])('keeps a separate later date authoritative: %s', date => {
    const parsed = parseReminderEditorContent(`Task every Monday ${date}`);
    expect(parsed).toMatchObject({ cleanContent: 'Task every Monday', datePart: date, recurrence: undefined, dateError: undefined });
});

it('keeps an earlier named-time recurrence literal when a later date wins', () => {
    expect(parseReminderEditorContent('Task every morning tomorrow')).toMatchObject({
        cleanContent: 'Task every morning', datePart: 'tomorrow', recurrence: undefined, dateError: undefined,
    });
});

it.each(['from 9 to 10', '09:00 - 10:00'])('rejects multiple repeat times that the rule cannot represent: %s', time => {
    const text = `Task every Monday ${time}`;
    expect(parseReminderEditorContent(text)).toMatchObject({ cleanContent: text,
        dueDate: undefined, recurrence: undefined, dateError: 'Use one time per repeat schedule.' });
});
