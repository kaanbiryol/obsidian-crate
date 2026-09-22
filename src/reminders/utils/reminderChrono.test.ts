import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chrono from 'chrono-node';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { buildRichTextSegments } from './richTextRenderer';
import { buildReminderSubmission } from '../ui/reminder-modal/reminderMutation';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';
import { buildModalDraft } from '@/pwa/reminder-modal-draft';
import { buildCreatedReminderBlock } from '../core/markdownReminderMutation';
import { buildInitialReminderContent } from '../core/reminderDraft';
import { parseCheckboxLine } from './checkboxParser';

const now = new Date('2026-09-21T13:00:37.123Z');
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('Chrono date and time recognition', () => {
    it.each([
        '2026-09-28T09:00Z', '2026-09-28T09:00+0100', '2026-09-28T9:00',
        '2026-02-30T09:00:00Z', '2026-13-01T09:00:00Z',
        'Friday 09:00:30 in the morning', '09:00:30', '09:00:30.123', 'tomorrow 09:00:30',
        'tomorrow 09:', 'tomorrow 09:00:', 'tomorrow 25:00', 'tomorrow 09:60', 'tomorrow 09:001', 'tomorrow 09:00UTC',
        'February 30 at 9 in the morning', 'February 30 morning at 09:00', '2027-02-29 at noon',
        'February 28 at 9 in the morning', '2028-02-29 at noon',
        '2026-02-30 09:00', '2026-02-30 at 9am', '2026-13-01 09:00',
        'February 30 09:00', 'Feb. 30th at 09:00', '30 February 09:00', '30th of February at noon',
        'April 31', '31 April 09:00', 'February 29, 2026 09:00', '29 Feb. 2026 at 09:00',
        'February 29', 'February 00', '32 February', 'February 29, 2100',
        '02/30/2027 09:00', '04/31/2027 at 09:00', '31/04/2027 at noon',
        '02/29/2027', '02/29/27', '02/29/2100', '2027/02/29 09:00',
        '00/10/2027', '12/00/2027', '13/13/2027', '32/04/2027', '04/32/2027',
        '2/30 09:00', '2/29', '31.04.2027 09:00', '04-31-2027 at 09:00', '2027-2-30 09:00',
        '2027.2.30 at noon', '31.04.27', '02-29-27', '2027-13-1', '2027-0-1', '2027-1-32', '2027-1-0',
    ])('uses Chrono’s complete result without rewriting the phrase: %s', phrase => {
        const content = `Task ${phrase}`;
        const expected = chrono.parse(content, now, { forwardDate: true }).at(-1);
        expect(expected?.end).toBeFalsy();
        const hasTime = expected?.start.isCertain('hour');
        const dueDate = expected?.start.date();
        if (dueDate && !hasTime) dueDate.setHours(0, 0, 0, 0);
        const cleanContent = expected
            ? (content.slice(0, expected.index) + content.slice(expected.index + expected.text.length)).replace(/\s+/g, ' ').trim()
            : content;
        expect(parseReminderEditorContent(content)).toMatchObject({
            cleanContent, datePart: expected?.text, dueDate, hasTime, dateError: undefined, recurrence: undefined,
        });
        expect(buildRichTextSegments(content).filter(segment => segment.kind === 'chip')).toEqual(
            expected ? [{ kind: 'chip', type: 'date', text: expected.text }] : [],
        );
        const plugin = buildReminderSubmission({ content, projects: [], priority: 4, project: 'Inbox', dueDate: null })!;
        expect(plugin.content).toBe(cleanContent);
        const pwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
            draft: { ...buildModalDraft(null, null), content } });
        expect(pwa.content).toBe(cleanContent);
        if (!expected) {
            expect(plugin.dueDate).toBeUndefined();
            expect(pwa.dueDate).toBeNull();
            expect(pwa.dueDatetime).toBeNull();
        }
    });

    it.each(['UTC', 'Europe/Berlin', 'America/New_York'])('keeps the whole unmatched morning phrase as text through reopening in %s', timezone => {
        vi.stubEnv('TZ', timezone);
        const content = 'Task February 30 at 9 in the morning';
        expect(chrono.parse(content, now, { forwardDate: true })).toEqual([]);
        const reminder = { id: 'unmatched', filePath: 'Reminders/Inbox.md', lineNumber: 0, content, project: 'Inbox', priority: 4 as const, completed: false };
        const plugin = buildReminderSubmission({ content: buildInitialReminderContent(reminder, 'Inbox'),
            projects: [], priority: 4, project: 'Inbox', dueDate: null, reminder });
        expect(plugin?.updatedReminder).toMatchObject({ content, dueDate: undefined, dueDatetime: undefined });
        const pwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'edit', projects: [], selectedProject: null,
            draft: buildModalDraft(reminder, null) });
        expect(pwa).toMatchObject({ content, dueDate: null, dueDatetime: null });
    });
});

describe.each(['UTC', 'Europe/Berlin', 'America/New_York'])('Chrono reminder schedules in %s', timezone => {
    it.each([
        ['Friday 09:00:30 in the morning UTC', '2026-09-25T09:00:30.000Z'],
        ['2026-09-25T09:00:30.123Z', '2026-09-25T09:00:30.123Z'],
        ['2026-09-25T09:00:30.123+02:00', '2026-09-25T07:00:30.123Z'],
        ['in 5 minutes', '2026-09-21T13:05:37.123Z'],
        ['in 2 hours', '2026-09-21T15:00:37.123Z'],
        ['now', '2026-09-21T13:00:37.123Z'],
        ['tomorrow 09:00 UTC', '2026-09-22T09:00:00.000Z'],
        ['tomorrow 09:00 +0200', '2026-09-22T07:00:00.000Z'],
        ['tomorrow 09:00 -0500', '2026-09-22T14:00:00.000Z'],
        ['tomorrow 09:00 GMT+0530', '2026-09-22T03:30:00.000Z'],
        ['tomorrow 09:00 EST', '2026-09-22T14:00:00.000Z'],
        ['September 28, 2026 09:00 UTC', '2026-09-28T09:00:00.000Z'],
    ])('preserves Chrono’s instant through both save/reopen paths: %s', (schedule, instant) => {
        vi.stubEnv('TZ', timezone);
        const content = `Call Alex ${schedule}`;
        const expected = chrono.parseDate(schedule, now, { forwardDate: true });
        expect(expected?.toISOString()).toBe(instant);
        expect(parseReminderEditorContent(content)).toMatchObject({
            cleanContent: 'Call Alex', datePart: schedule, dueDate: expected, hasTime: true,
            recurrence: undefined, dateError: undefined,
        });
        expect(buildRichTextSegments(content)).toEqual([
            { kind: 'text', text: 'Call Alex ' }, { kind: 'chip', type: 'date', text: schedule },
        ]);
        const plugin = buildReminderSubmission({ content, projects: [], priority: 4, project: 'Inbox', dueDate: null })!;
        expect(plugin).toMatchObject({ content: 'Call Alex', dueDate: instant, hasTime: true });
        const pwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
            draft: { ...buildModalDraft(null, null), content } });
        expect(pwa).toMatchObject({ content: 'Call Alex', dueDatetime: instant });
        const stored = buildCreatedReminderBlock({ content: plugin.content, dueDate: new Date(plugin.dueDate!),
            hasTime: plugin.hasTime, priority: plugin.priority, reminderId: 'chrono-roundtrip' });
        expect(parseCheckboxLine(stored.checkboxLine, { persisted: true })?.parsed).toMatchObject({
            cleanContent: 'Call Alex', dueDate: expected, hasTime: true,
        });
        const reminder = { id: 'chrono-roundtrip', filePath: 'Reminders/Inbox.md', content: 'Call Alex', project: 'Inbox', priority: 4 as const,
            completed: false, dueDate: stored.dueDateKey, dueDatetime: stored.dueDatetime };
        const reopenedPlugin = buildReminderSubmission({ content: buildInitialReminderContent(reminder, 'Inbox'),
            projects: [], priority: 4, project: 'Inbox', dueDate: stored.dueDatetime!, hasTime: true, reminder });
        expect(reopenedPlugin?.updatedReminder?.dueDatetime).toBe(instant);
        const reopenedPwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'edit', projects: [], selectedProject: null,
            draft: buildModalDraft(reminder, null) });
        expect(reopenedPwa.dueDatetime).toBe(instant);
    });
});

it.each(['UTC', 'America/New_York', '-03:30'])('preserves one-off fractional seconds with %s', zone => {
    vi.stubEnv('TZ', 'UTC');
    const parsed = parseReminderEditorContent(`Task Friday 09:00:30.123 ${zone}`);
    const expected = zone === 'UTC' ? '2026-09-25T09:00:30.123Z'
        : zone === 'America/New_York' ? '2026-09-25T13:00:30.123Z' : '2026-09-25T12:30:30.123Z';
    expect(parsed).toMatchObject({ cleanContent: 'Task', dateError: undefined, dueDate: new Date(expected) });
});

it.each(['2026-09-25T09:00:45.456Z', '2026-09-25T09:00:00.000Z'])('allows editing seconds without restoring the old instant: %s', dueDatetime => {
    vi.stubEnv('TZ', 'UTC');
    const reminder = { id: 'seconds-edit', filePath: 'Reminders/Inbox.md', content: 'Task', project: 'Inbox', priority: 4 as const, completed: false,
        dueDatetime: '2026-09-25T09:00:30.123Z' };
    const content = `Task ${dueDatetime}`;
    const plugin = buildReminderSubmission({ content, projects: [], project: 'Inbox', priority: 4,
        dueDate: reminder.dueDatetime, hasTime: true, reminder });
    expect(plugin?.updatedReminder?.dueDatetime).toBe(dueDatetime);
    const pwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'edit', projects: [], selectedProject: null,
        draft: { ...buildModalDraft(reminder, null), content } });
    expect(pwa.dueDatetime).toBe(dueDatetime);
});
