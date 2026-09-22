import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chrono from 'chrono-node';
import { resetLocalTimeZone } from '@internationalized/date';
import { buildModalDraft } from '@/pwa/reminder-modal-draft';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';
import { buildCreatedReminderBlock, buildUpdatedReminderBlock } from '../core/markdownReminderMutation';
import { scanReminderMarkdownContent } from '../core/markdownScan';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';
import { buildInitialReminderContent, rebuildReminderContent } from '../core/reminderDraft';
import { buildReminderSubmission } from '../ui/reminder-modal/reminderMutation';
import { parseReminderEditorContent } from './reminderEditorParsing';
import { buildRichTextSegments } from './richTextRenderer';

const now = new Date('2026-09-21T13:00:37.123Z');
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetLocalTimeZone();
});

describe.each(['UTC', 'Europe/Berlin', 'America/New_York'])('preserving weekday title text in %s', timezone => {
    it.each([
        'Notes from Monday', 'Notes from Friday', 'Notes from next Monday', 'Notes from Mon.', 'Notes from Monday,',
    ])('preserves %s through storage, reopening and picker changes', title => {
        vi.stubEnv('TZ', timezone);
        resetLocalTimeZone();
        for (const schedule of ['Friday', 'Friday 09:00', 'Friday 09:00:30.123']) {
            const content = `${title} ${schedule}`;
            const parsed = parseReminderEditorContent(content);
            expect(parsed).toMatchObject({ cleanContent: title, datePart: schedule, dateError: undefined });
            const plugin = buildReminderSubmission({ content, projects: [], priority: 4, project: 'Inbox', dueDate: null })!;
            const pwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
                draft: { ...buildModalDraft(null, null), content } });
            expect(plugin.content).toBe(title);
            expect(pwa.content).toBe(title);
            const stored = buildCreatedReminderBlock({ content: plugin.content, dueDate: parsed.dueDate,
                hasTime: plugin.hasTime, priority: plugin.priority, reminderId: 'title' });
            const read = (line: string) => scanReminderMarkdownContent('Reminders/Inbox.md', line, 'Reminders').reminders[0]!;
            const reminder = read(stored.checkboxLine);
            expect(reminder).toMatchObject({ content: title, dueDate: stored.dueDateKey, dueDatetime: stored.dueDatetime });
            expect(normalizeReminderScheduleLine(stored.checkboxLine)).toBe(stored.checkboxLine);
            const reopened = buildInitialReminderContent(reminder, 'Inbox');
            expect(buildRichTextSegments(reopened)[0]).toEqual({ kind: 'text', text: `${title} ` });
            const reopenedPlugin = buildReminderSubmission({ content: reopened,
                projects: [], priority: 4, project: 'Inbox', dueDate: plugin.dueDate!, hasTime: plugin.hasTime, reminder });
            expect(reopenedPlugin?.updatedReminder).toMatchObject({ content: title,
                dueDate: stored.dueDateKey, dueDatetime: stored.dueDatetime });
            const reopenedPwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'edit', projects: [], selectedProject: null,
                draft: buildModalDraft(reminder, null) });
            expect(reopenedPwa).toMatchObject({ content: title, dueDate: pwa.dueDate, dueDatetime: pwa.dueDatetime });
            const changed = rebuildReminderContent(title, plugin.dueDate!, undefined, 'Work', 1, 'Inbox', plugin.hasTime);
            expect(parseReminderEditorContent(changed, ['Work'])).toMatchObject({ cleanContent: title,
                dueDate: parsed.dueDate, hasTime: parsed.hasTime, project: 'Work', priority: 1 });
            const completed = buildUpdatedReminderBlock(reminder, { priority: 1 });
            expect(read(completed.checkboxLine)).toMatchObject({ content: title, priority: 1,
                dueDate: stored.dueDateKey, dueDatetime: stored.dueDatetime });
        }
    });
});

it.each([
    ['Monday Sep 25, 2026', 'Monday', 'Sep 25, 2026'],
    ['Friday Sep 25, 2026', 'Friday', 'Sep 25, 2026'],
    ['Monday,Sep 25, 2026', 'Monday,', 'Sep 25, 2026'],
    ['on Monday Sep 25, 2026', 'on Monday', 'Sep 25, 2026'],
    ['Monday 2026-09-25T09:00:30.123-03:30', 'Monday', '2026-09-25T09:00:30.123-03:30'],
])('keeps the earlier weekday literal when followed by a complete calendar date: %s', (schedule, title, datePart) => {
    const expected = chrono.parseDate(datePart, now, { forwardDate: true })!;
    const hasTime = chrono.parse(datePart, now, { forwardDate: true })[0]!.start.isCertain('hour');
    if (!hasTime) expected.setHours(0, 0, 0, 0);
    expect(parseReminderEditorContent(`Task ${schedule}`)).toMatchObject({
        cleanContent: `Task ${title}`, datePart, dueDate: expected, hasTime, dateError: undefined,
    });
});

it.each(['Monday 09:00', 'next Friday at noon', 'Monday at 9 in the morning', 'Friday September 25', 'Friday, September 25'])('keeps Chrono weekday wording intact: %s', schedule => {
    expect(parseReminderEditorContent(`Task ${schedule}`)).toMatchObject({
        cleanContent: 'Task', datePart: chrono.parse(schedule, now, { forwardDate: true })[0]!.text, dateError: undefined,
    });
});
