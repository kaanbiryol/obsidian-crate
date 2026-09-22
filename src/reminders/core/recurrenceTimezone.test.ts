import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import { parseReminderEditorContent } from '../utils/reminderEditorParsing';
import { parseCheckboxLine } from '../utils/checkboxParser';
import { calculateFirstOccurrence, calculateNextOccurrence } from '../utils/recurrenceCalculator';
import { buildCreatedReminderBlock, buildReminderCompletionPlan } from './markdownReminderMutation';
import { buildInitialReminderContent, applyReminderDraftContentUpdate } from './reminderDraft';
import { buildReminderSubmission } from '../ui/reminder-modal/reminderMutation';
import { buildModalDraft } from '@/pwa/reminder-modal-draft';
import { applyReminderTextUpdate, deriveDraftPatchFromContent } from '@/pwa/reminder-state';
import { buildReminderMutationBody } from '@/pwa/reminder-mutation';
import { buildRecurrencePickerState, recurrenceRuleFromPickerState } from '../ui/reminder-modal/recurrencePickerShared';
import { preserveRecurrenceMetadata } from '../utils/recurrenceRule';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T13:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetLocalTimeZone(); });

describe.each(['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])('recurrence persistence on a device in %s', hostZone => {
    it.each(['Europe/Berlin', 'America/New_York', '+14:00', '-03:30'])('keeps all-day weekday dates in %s through creation and completion', timezone => {
        vi.stubEnv('TZ', hostZone); resetLocalTimeZone();
        vi.setSystemTime(new Date('2026-10-24T23:30Z'));
        const recurrence = parseReminderEditorContent(`Task every Monday ${timezone}`).recurrence!;
        const block = buildCreatedReminderBlock({ content: 'Task', priority: 4, dueDate: undefined,
            recurrence, reminderId: 'all-day-zone' });
        expect(block.dueDateKey).toBe('2026-10-26');
        expect(block.dueDatetime).toBeUndefined();
        const saved = { id: 'all-day-zone', filePath: 'Reminders/Inbox.md', lineNumber: 0, rawLine: block.checkboxLine,
            content: 'Task', project: 'Inbox', completed: false, priority: 4 as const, dueDate: block.dueDateKey, recurrence };
        expect(parseCheckboxLine(block.checkboxLine, { persisted: true })!.parsed.recurrence).toEqual(recurrence);
        const complete = buildReminderCompletionPlan(saved, true);
        expect(complete).toMatchObject({ completed: false, dueDate: '2026-11-02', recurrence: { timezone, completedCount: 1 } });
        expect(complete.dueDatetime).toBeUndefined();
        expect(parseReminderEditorContent(buildModalDraft(saved, null).content).recurrence).toEqual(recurrence);
    });

    it.each(['Europe/Berlin', 'America/New_York', '+05:30', '-03:30', 'Pacific/Chatham', 'US/Eastern', 'CET', '+00:00'])('preserves %s through both editors and picker changes', timezone => {
        vi.stubEnv('TZ', hostZone); resetLocalTimeZone();
        const recurrence = { frequency: 'weekly' as const, daysOfWeek: [1], hour: 9, minute: 0, timezone,
            count: 8, completedCount: 3, endDate: '2027-12-31' };
        const instant = calculateFirstOccurrence(recurrence);
        instant.setSeconds(37, 123);
        const block = buildCreatedReminderBlock({ content: 'Call Alex', priority: 4, recurrence,
            dueDate: instant, hasTime: true, reminderId: 'timezone-roundtrip' });
        const persisted = parseCheckboxLine(block.checkboxLine, { persisted: true })!.parsed;
        expect(persisted).toMatchObject({ cleanContent: 'Call Alex', recurrence, dueDate: instant, hasTime: true });
        const reminder = { id: 'timezone-roundtrip', filePath: 'Reminders/Inbox.md', content: persisted.cleanContent,
            priority: 4 as const, project: 'Inbox', completed: false, recurrence: persisted.recurrence,
            dueDate: block.dueDateKey, dueDatetime: block.dueDatetime };
        const originalContent = buildInitialReminderContent(reminder, 'Inbox');
        expect(buildModalDraft(reminder, null).content).toBe(originalContent);

        for (const edit of ['title', 'priority', 'project'] as const) {
            const plugin = { content: originalContent, dueDate: reminder.dueDatetime!, hasTime: true,
                recurrence, project: 'Inbox', priority: 4 as const };
            if (edit === 'title') plugin.content = plugin.content.replace('Call Alex', 'Call Sam');
            const pluginDraft = edit === 'title' ? plugin : applyReminderDraftContentUpdate(plugin,
                edit === 'priority' ? { priority: 1 } : { project: 'Work' }, ['Inbox', 'Work'], 'Inbox');
            const submission = buildReminderSubmission({ ...pluginDraft, projects: ['Inbox', 'Work'], reminder })!;
            expect(submission.updatedReminder).toMatchObject({ recurrence, dueDatetime: instant.toISOString() });

            let pwa = buildModalDraft(reminder, null);
            if (edit === 'title') pwa.content = pwa.content.replace('Call Alex', 'Call Sam');
            else pwa = { ...pwa, ...applyReminderTextUpdate(pwa, ['Inbox', 'Work'], edit === 'priority' ? { priority: 1 } : { project: 'Work' }) };
            pwa = { ...pwa, ...deriveDraftPatchFromContent(pwa, ['Inbox', 'Work']) };
            const body = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, draft: pwa, mode: 'edit', projects: ['Inbox', 'Work'], selectedProject: null });
            expect(body).toMatchObject({ content: submission.content, project: submission.project, priority: submission.priority,
                recurrence, dueDatetime: instant.toISOString() });
        }

        const picker = buildRecurrencePickerState(recurrence);
        const changedRule = recurrenceRuleFromPickerState({ ...picker, hour: 10 }, recurrence.timezone);
        expect(changedRule).toMatchObject({ timezone, hour: 10 });
        expect(calculateNextOccurrence(instant, changedRule)).not.toBeNull();
    });
});

it('changing or deleting an explicit timezone recalculates the occurrence in both editors', () => {
    vi.stubEnv('TZ', 'UTC'); resetLocalTimeZone();
    const recurrence = { frequency: 'weekly' as const, daysOfWeek: [1], hour: 9, minute: 0,
        timezone: 'America/New_York', count: 8, completedCount: 3 };
    const reminder = { id: 'one', filePath: 'Reminders/Inbox.md', content: 'Task', project: 'Inbox', priority: 4 as const,
        completed: false, recurrence, dueDatetime: '2026-10-26T13:00:00.000Z' };
    for (const zone of ['Europe/Berlin', '']) {
        const content = `Task every Mon 09:00 ${zone}`.trimEnd();
        const parsed = parseReminderEditorContent(content);
        const updatedRule = preserveRecurrenceMetadata(parsed.recurrence, recurrence);
        expect(updatedRule).not.toBe(recurrence);
        expect(updatedRule?.timezone).toBe(zone || 'UTC');
        const plugin = buildReminderSubmission({ content, projects: [], project: 'Inbox', priority: 4, dueDate: null,
            hasTime: false, recurrence: updatedRule, reminder });
        expect(plugin?.updatedReminder).toMatchObject({ recurrence: updatedRule, dueDatetime: undefined });
        const pwa = { ...buildModalDraft(reminder, null), content };
        Object.assign(pwa, deriveDraftPatchFromContent(pwa, []));
        const body = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, draft: pwa, mode: 'edit', projects: [], selectedProject: null });
        expect(body).toMatchObject({ recurrence: updatedRule, dueDatetime: null, dueDate: null });
    }
});

it.each([
    ['UTC', '2026-09-28T09:00:30.123Z', '2026-10-05T09:00:30.123Z'],
    ['America/New_York', '2026-09-21T13:00:30.123Z', '2026-09-28T13:00:30.123Z'],
    ['-03:30', '2026-09-28T12:30:30.123Z', '2026-10-05T12:30:30.123Z'],
])('keeps Chrono seconds through recurrence creation, reopening and completion in %s', (timezone, first, next) => {
    vi.stubEnv('TZ', 'UTC'); resetLocalTimeZone();
    const content = `Call Alex every Monday 09:00:30.123 ${timezone}`;
    const plugin = buildReminderSubmission({ content, projects: [], project: 'Inbox', priority: 4, dueDate: null })!;
    const pwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'create', projects: [], selectedProject: null,
        draft: { ...buildModalDraft(null, null), content } });
    expect(pwa.recurrence).toEqual(plugin.recurrence);
    expect(plugin.recurrence).toMatchObject({ frequency: 'weekly', hour: 9, minute: 0, second: 30, millisecond: 123, timezone });
    const block = buildCreatedReminderBlock({ content: plugin.content, priority: 4, dueDate: undefined,
        recurrence: plugin.recurrence, reminderId: 'precise-repeat' });
    expect(block.dueDatetime).toBe(first);
    const persisted = parseCheckboxLine(block.checkboxLine, { persisted: true })!.parsed;
    expect(persisted.recurrence).toEqual(plugin.recurrence);
    const reminder = { id: 'precise-repeat', filePath: 'Reminders/Inbox.md', lineNumber: 0, rawLine: block.checkboxLine, content: persisted.cleanContent, priority: 4 as const,
        project: 'Inbox', completed: false, dueDatetime: block.dueDatetime, recurrence: persisted.recurrence };
    const reopenedPlugin = buildReminderSubmission({ content: buildInitialReminderContent(reminder, 'Inbox'),
        projects: [], project: 'Inbox', priority: 4, dueDate: first, hasTime: true, recurrence: reminder.recurrence, reminder });
    expect(reopenedPlugin?.updatedReminder).toMatchObject({ dueDatetime: first, recurrence: reminder.recurrence });
    const reopenedPwa = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, mode: 'edit', projects: [], selectedProject: null,
        draft: buildModalDraft(reminder, null) });
    expect(reopenedPwa).toMatchObject({ dueDatetime: first, recurrence: reminder.recurrence });
    expect(buildReminderCompletionPlan(reminder, true)).toMatchObject({ dueDatetime: next,
        recurrence: { second: 30, millisecond: 123, completedCount: 1 } });
});
