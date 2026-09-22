import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import { buildModalDraft } from '@/pwa/reminder-modal-draft';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';
import { buildCreatedReminderBlock } from '../core/markdownReminderMutation';
import { scanReminderMarkdownContent } from '../core/markdownScan';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { buildInitialReminderContent } from '../core/reminderDraft';
import { buildReminderSubmission } from '../ui/reminder-modal/reminderMutation';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { buildRichTextSegments } from './richTextRenderer';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T13:00:37.123Z'));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetLocalTimeZone();
});

describe.each(['UTC', 'Europe/Berlin', 'America/New_York'])('reminder range endpoints in %s', timezone => {
    it.each([
        ['Friday', '2026-09-25T00:00:00', false],
        ['Friday 09:00', '2026-09-25T09:00:00', true],
        ['2026-09-25', '2026-09-25T00:00:00', false],
        ['2026-09-25 09:00', '2026-09-25T09:00:00', true],
        ['2026-09-25T09:00:00.000Z', '2026-09-25T09:00:00.000Z', true],
        ['2026-09-25T09:00:30.123+02:00', '2026-09-25T07:00:30.123Z', true],
        ['2026-09-25T09:00:30.123-03:30', '2026-09-25T12:30:30.123Z', true],
    ] as const)('saves and reopens the full final endpoint: %s', (endpoint, instant, hasTime) => {
        vi.stubEnv('TZ', timezone);
        resetLocalTimeZone();
        const content = `Compare Monday to ${endpoint}`;
        const cleanContent = 'Compare Monday to';
        const dueDate = new Date(instant);
        const parsed = parseReminderEditorContent(content);
        expect(parsed).toMatchObject({ cleanContent, datePart: endpoint, dueDate, hasTime, dateError: undefined });
        expect(buildRichTextSegments(content)).toEqual([
            { kind: 'text', text: `${cleanContent} ` }, { kind: 'chip', type: 'date', text: endpoint },
        ]);
        const plugin = buildReminderSubmission({ content, projects: [], priority: 4, project: 'Inbox', dueDate: null })!;
        const pwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
            draft: { ...buildModalDraft(null, null), content } });
        expect(plugin).toMatchObject({ content: cleanContent, dueDate: hasTime ? dueDate.toISOString() : '2026-09-25', hasTime });
        expect(pwa).toMatchObject({ content: cleanContent, dueDate: '2026-09-25', dueDatetime: hasTime ? dueDate.toISOString() : null });
        const stored = buildCreatedReminderBlock({ content: plugin.content, dueDate: parsed.dueDate,
            hasTime: plugin.hasTime, priority: plugin.priority, reminderId: 'range' });
        vi.setSystemTime(new Date('2028-04-10T23:58:00Z'));
        expect(normalizeReminderScheduleLine(stored.checkboxLine)).toBe(stored.checkboxLine);
        const reminder = scanReminderMarkdownContent('Reminders/Inbox.md', stored.checkboxLine, 'Reminders').reminders[0]!;
        expect(reminder).toMatchObject({ content: cleanContent, dueDate: '2026-09-25' });
        expect(reminder.dueDatetime).toBe(hasTime ? dueDate.toISOString() : undefined);
        const reopenedPlugin = buildReminderSubmission({ content: buildInitialReminderContent(reminder, 'Inbox'),
            projects: [], priority: 4, project: 'Inbox', dueDate: plugin.dueDate!, hasTime, reminder });
        expect(reopenedPlugin?.updatedReminder).toMatchObject({ content: cleanContent, dueDate: '2026-09-25' });
        expect(reopenedPlugin?.updatedReminder?.dueDatetime).toBe(reminder.dueDatetime);
        const reopenedPwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'edit', projects: [], selectedProject: null,
            draft: buildModalDraft(reminder, null) });
        expect(reopenedPwa).toMatchObject({ content: cleanContent, dueDate: '2026-09-25', dueDatetime: pwa.dueDatetime });
    });
});

it.each(['to', 'through', 'until', 'till', '-', '–'])('keeps the title and complete ISO endpoint around %s', connector => {
    vi.stubEnv('TZ', 'UTC');
    const endpoint = '2026-09-25T09:00:30.123Z';
    expect(parseReminderEditorContent(`Compare Monday ${connector} ${endpoint}`)).toMatchObject({
        cleanContent: `Compare Monday ${connector}`, datePart: endpoint,
        dueDate: new Date(endpoint), hasTime: true, dateError: undefined,
    });
});

it.each([' to ', '-', ' – '])('uses the last written date even in a reversed range separated by %s', connector => {
    vi.stubEnv('TZ', 'UTC');
    expect(parseReminderEditorContent(`Compare 2026-09-25${connector}2026-09-21`)).toMatchObject({
        cleanContent: `Compare 2026-09-25${connector}`.trim(), datePart: '2026-09-21',
        dueDate: new Date('2026-09-21T00:00:00Z'), hasTime: false, dateError: undefined,
    });
});

it.each([
    ['Friday 09:00', '2026-09-25T09:00:00.000Z'],
    ['Friday 09:00 -03:30', '2026-09-25T12:30:00.000Z'],
])('normalizes a handwritten range once without splitting its timestamp: %s', (endpoint, instant) => {
    vi.stubEnv('TZ', 'UTC');
    const normalized = normalizeReminderScheduleLine(`- [ ] Compare Monday to ${endpoint} <!-- crate-id:range -->`);
    expect(normalized).toBe(`- [ ] Compare Monday to ${instant} <!-- crate-id:range -->`);
    for (const timezone of ['UTC', 'Europe/Berlin', 'America/New_York']) {
        vi.stubEnv('TZ', timezone);
        resetLocalTimeZone();
        vi.setSystemTime(new Date('2028-04-10T23:58:00Z'));
        expect(normalizeReminderScheduleLine(normalized)).toBe(normalized);
        expect(scanReminderMarkdownContent('Reminders/Inbox.md', normalized, 'Reminders').reminders[0]).toMatchObject({
            content: 'Compare Monday to', dueDatetime: instant,
        });
    }
});
