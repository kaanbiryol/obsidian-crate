import { expect, it } from 'vitest';
import { deriveReminderDraftContentMetadata, type ReminderDraftContentState } from '../../../core/reminderDraft';
import { draftContentHasSchedule, reconcileDraftWithText } from './useReminderDraft';

const projects = ['Inbox', 'Work'];
const draft = (content: string, overrides: Partial<ReminderDraftContentState> = {}): ReminderDraftContentState => ({
	content, dueDate: null, recurrence: undefined, project: 'Inbox', priority: 4, hasTime: false, ...overrides,
});
const reconcile = (state: ReminderDraftContentState, schedule = { initialContentHadSchedule: false, dueDateSetFromText: false }) =>
	reconcileDraftWithText(state, deriveReminderDraftContentMetadata(state.content, projects, 'Inbox'), schedule);

it('detects a date or recurrence in draft text', () => {
	expect(draftContentHasSchedule('Call Ada tomorrow', projects, 'Inbox')).toBe(true);
	expect(draftContentHasSchedule('Call Ada every week', projects, 'Inbox')).toBe(true);
	expect(draftContentHasSchedule('Call Ada #Work !', projects, 'Inbox')).toBe(false);
});

it('takes a date typed in the text and clears it once the text drops it', () => {
	const typed = reconcile(draft('Call Ada tomorrow #Work'));
	expect(typed.dueDateSetFromText).toBe(true);
	expect(typed.state).toMatchObject({ project: 'Work', hasTime: false });
	expect(typed.state.dueDate).not.toBeNull();

	const removed = reconcile({ ...typed.state, content: 'Call Ada #Work' }, { initialContentHadSchedule: false, dueDateSetFromText: true });
	expect(removed).toMatchObject({ dueDateSetFromText: false, state: { dueDate: null } });
});

it('keeps a picked date that the text never set, unless the draft started with a schedule', () => {
	const picked = draft('Call Ada', { dueDate: '2026-11-03' });
	expect(reconcile(picked).state.dueDate).toBe('2026-11-03');
	expect(reconcile(picked, { initialContentHadSchedule: true, dueDateSetFromText: false }).state.dueDate).toBeNull();
});

it('keeps the current recurrence object when the text describes the same rule', () => {
	const first = reconcile(draft('Call Ada every week'));
	expect(first.state.recurrence).toBeDefined();
	expect(reconcile(first.state).state.recurrence).toBe(first.state.recurrence);
});
