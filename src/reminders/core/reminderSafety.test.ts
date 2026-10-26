import { afterEach, describe, expect, it } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import { rebuildCheckboxLine, parseCheckboxLine } from './grammar/checkboxParser';
import { scanReminderMarkdownContent } from './markdownScan';
import { buildCreatedReminderBlock, buildUpdatedReminderBlock, replaceUpdatedReminderBlock } from './markdownReminderMutation';
import { setReminderCompletionInContent } from './reminderCompletion';
import { deleteReminderBlockFromContent } from './markdownReminderFile';
import { buildModalDraft } from '@/pwa/reminders/editor/reminder-drafts';
import { deriveDraftPatchFromContent } from '@/pwa/reminders/editor/editor-draft';
import { buildReminderSubmission } from '../ui/plugin/reminder-modal/reminderMutation';
import { buildReminderMutationBody } from '@/pwa/reminders/outbox/reminder-mutation';

const originalTZ = process.env.TZ;
afterEach(() => { process.env.TZ = originalTZ; resetLocalTimeZone(); });
function record(content: string) { return scanReminderMarkdownContent('Reminders/Inbox.md', content, 'Reminders').reminders[0]!; }
const rule = { frequency: 'daily' as const, timezone: 'America/New_York', hour: 9, minute: 0, count: 3, endDate: '2099-04-01' };

describe('reminder editing boundaries', () => {
	it.each(['title', 'description'])('rejects stale plugin update, completion, and delete after a %s edit', field => {
		const old = '- [ ] Task <!-- crate-id:one -->\n<!-- crate-desc:v1:old -->\n';
		const stale = record(old);
		const current = field === 'title' ? old.replace('Task', 'New title') : old.replace('crate-desc:v1:old', 'crate-desc:v1:new');
		expect(() => replaceUpdatedReminderBlock(current, stale, buildUpdatedReminderBlock(stale, { priority: 1 }))).toThrow('changed');
		expect(() => setReminderCompletionInContent(current, stale, true)).toThrow('changed');
		expect(() => deleteReminderBlockFromContent(current, stale)).toThrow('changed');
	});
	it('allows unrelated edits and moved lines without discarding their contents', () => {
		const old = '- [ ] Task <!-- crate-id:one -->\n';
		const next = replaceUpdatedReminderBlock(`# New heading\n${old}`, record(old), buildUpdatedReminderBlock(record(old), { priority: 1 }));
		expect(next.content).toContain('# New heading');
		expect(next.content).toContain('Task !');
	});
});

describe('canonical reminder dates', () => {
	it.each(['UTC', 'Pacific/Honolulu', 'Asia/Tokyo', 'America/New_York'])('preserves instant and recurrence metadata when read in %s', zone => {
		process.env.TZ = 'Europe/Berlin'; resetLocalTimeZone();
		const line = rebuildCheckboxLine({ completed: false, content: 'Task', dueDate: new Date('2099-03-01T14:00:00.000Z'), priority: 1, recurrence: rule, hasTime: true, reminderId: 'one' });
		process.env.TZ = zone; resetLocalTimeZone();
		const parsed = parseCheckboxLine(line)!;
		expect(parsed.parsed.dueDate?.toISOString()).toBe('2099-03-01T14:00:00.000Z');
		expect(parsed.parsed.recurrence).toEqual(rule);
		expect(parsed.parsed.cleanContent).toBe('Task');
	});
	it('persists recurrence progress and stops after the configured number of completions', () => {
		let content = rebuildCheckboxLine({ completed: false, content: 'Task', dueDate: new Date('2099-03-01T14:00:00Z'), priority: 4, recurrence: rule, hasTime: true, reminderId: 'one' });
		for (let count = 1; count <= 3; count++) {
			content = setReminderCompletionInContent(content, record(content), true).content;
			expect(record(content).recurrence?.completedCount).toBe(count);
			expect(record(content).completed).toBe(count === 3);
		}
		expect(setReminderCompletionInContent(content, record(content), true).content).toBe(content);
	});
	it.each(['UTC', 'Asia/Tokyo', 'Pacific/Honolulu'])('advances an all-day rule by calendar day in %s', zone => {
		process.env.TZ = zone; resetLocalTimeZone();
		const allDayRule = { frequency: 'daily' as const, timezone: 'Pacific/Honolulu', endDate: '2099-01-02' };
		let content = rebuildCheckboxLine({ completed: false, content: 'Task', dueDate: new Date(2099, 0, 1), priority: 4, recurrence: allDayRule, hasTime: false, reminderId: 'one' });
		content = setReminderCompletionInContent(content, record(content), true).content;
		expect(record(content)).toMatchObject({ dueDate: '2099-01-02', dueDatetime: undefined, completed: false });
		content = setReminderCompletionInContent(content, record(content), true).content;
		expect(record(content).completed).toBe(true);
		const created = buildCreatedReminderBlock({ content: 'New', dueDate: undefined, priority: 4, recurrence: allDayRule, reminderId: 'new' });
		expect(created.hasTime).toBe(false);
		expect(created.dueDatetime).toBeUndefined();
	});
	it('keeps occurrence and timezone when editing only a PWA title', () => {
		const reminder = record(rebuildCheckboxLine({ completed: false, content: 'Task', dueDate: new Date('2099-03-01T14:00:00Z'), priority: 4, recurrence: rule, hasTime: true, reminderId: 'one' }));
		const draft = buildModalDraft(reminder, null);
		draft.content = draft.content.replace('Task', 'Edited');
    Object.assign(draft, deriveDraftPatchFromContent(draft, ['Inbox']));
		const body = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, draft, mode: 'edit', projects: ['Inbox'], selectedProject: null });
		expect(body.recurrence).toEqual(rule);
		expect(body.dueDatetime).toBe('2099-03-01T14:00:00.000Z');
	});
	it('uses a manually changed readable rule and ignores malformed metadata', () => {
		const line = rebuildCheckboxLine({ completed: false, content: 'Task', dueDate: new Date('2099-03-01T14:00:00Z'), priority: 4, recurrence: rule, hasTime: true, reminderId: 'one' });
		expect(parseCheckboxLine(line.replace('daily', 'weekly'))?.parsed.recurrence?.count).toBeUndefined();
	});
});

it.each(['2099-03-01T14:00:37.123Z', '2026-11-01T06:30:37.123Z'])('preserves exact instant through plugin and PWA title-edit form derivation: %s', instant => {
  process.env.TZ = 'America/New_York'; resetLocalTimeZone();
  const reminder = record(rebuildCheckboxLine({ completed: false, content: 'Task', dueDate: new Date(instant), priority: 4, hasTime: true, reminderId: 'one' }));
  const draft = buildModalDraft(reminder, null);
  draft.content = draft.content.replace('Task', 'Edited');
  Object.assign(draft, deriveDraftPatchFromContent(draft, ['Inbox']));
  const body = buildReminderMutationBody({ config: { folderPath: 'Reminders' }, draft, mode: 'edit', projects: ['Inbox'], selectedProject: null });
  expect(body.dueDatetime).toBe(instant);
  const submission = buildReminderSubmission({ content: draft.content, description: '', projects: ['Inbox'], priority: 4, project: 'Inbox', dueDate: instant, hasTime: true, reminder });
  expect(submission?.updatedReminder?.dueDatetime).toBe(instant);
});
it('retains recurrence occurrence, timezone and progress through plugin form submission', () => {
  const originalRule = { ...rule, completedCount: 1 };
  const reminder = record(rebuildCheckboxLine({ completed: false, content: 'Task', dueDate: new Date('2099-03-01T14:00:00Z'), priority: 4, recurrence: originalRule, hasTime: true, reminderId: 'one' }));
  const draft = buildModalDraft(reminder, null);
  const submission = buildReminderSubmission({ content: draft.content.replace('Task', 'Edited'), projects: ['Inbox'], priority: 4, project: 'Inbox', dueDate: reminder.dueDatetime!, hasTime: true, recurrence: reminder.recurrence, reminder });
  expect(submission?.updatedReminder).toMatchObject({ dueDatetime: reminder.dueDatetime, recurrence: originalRule });
});
