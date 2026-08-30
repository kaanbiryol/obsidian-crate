import { describe, expect, it } from 'vitest';
import { applyReminderDraftContentUpdate } from '@/reminders/core/reminderDraft';
import type { ReminderDraftContentState } from '@/reminders/core/reminderDraft';
import { buildInboxViewModel } from '@/reminders/ui/views/viewModels';
import {
	applyReminderTextUpdate,
	hasReminderDraftTitle,
} from './reminder-state';
import { reorderProjectReminders, toSharedReminder } from './reminder-list-state';
import type { ModalDraft, ReminderRecord } from './types';

function createModalDraft(overrides: Partial<ModalDraft> = {}): ModalDraft {
	return {
		content: 'Task',
		description: '',
		project: 'Inbox',
		defaultProject: 'Inbox',
		priority: 4,
		dueDate: '',
		dueTime: '',
		recurrence: undefined,
		activePicker: null,
		deleteConfirm: false,
		...overrides,
	};
}

function applyModalPatch(draft: ModalDraft, patch: Partial<ModalDraft>): ModalDraft {
	return { ...draft, ...patch };
}

function createReminderRecord(id: string, lineNumber: number, overrides: Partial<ReminderRecord> = {}): ReminderRecord {
	return {
		id,
		content: `Task ${id}`,
		priority: 4,
		completed: false,
		project: 'Inbox',
		filePath: 'Reminders/Inbox.md',
		lineNumber,
		...overrides,
	};
}

describe('PWA reminder state', () => {
	it('requires a human-readable title instead of metadata-only content', () => {
		const projects = ['Inbox', 'Work'];

		expect(hasReminderDraftTitle('', projects, 'Inbox')).toBe(false);
		expect(hasReminderDraftTitle('!', projects, 'Inbox')).toBe(false);
		expect(hasReminderDraftTitle('#Work !', projects, 'Inbox')).toBe(false);
		expect(hasReminderDraftTitle('Finish report #Work !', projects, 'Inbox')).toBe(true);
	});

	it('keeps the dropped order when the Inbox view re-sorts optimistic reminders', () => {
		const reminders = [
			createReminderRecord('a', 2),
			createReminderRecord('b', 4),
			createReminderRecord('c', 6),
			createReminderRecord('done', 8, { completed: true }),
		];

		const reordered = reorderProjectReminders(reminders, 'Inbox', ['c', 'a', 'b']);
		const viewModel = buildInboxViewModel(reordered.map(toSharedReminder));

		expect(viewModel.active.map((reminder) => reminder.id)).toEqual(['c', 'a', 'b']);
		expect(reordered.filter((reminder) => !reminder.completed).map((reminder) => reminder.lineNumber)).toEqual([2, 4, 6]);
	});

	it('matches shared project and priority updates', () => {
		const projects = ['Inbox', 'Work'];
		const initialShared: ReminderDraftContentState = {
			content: 'Task',
			dueDate: null,
			recurrence: undefined,
			project: 'Inbox',
			priority: 4,
			hasTime: false,
		};
		const sharedWithProject = applyReminderDraftContentUpdate(
			initialShared,
			{ project: 'Work' },
			projects,
			'Inbox',
		);
		const shared = applyReminderDraftContentUpdate(
			sharedWithProject,
			{ priority: 1 },
			projects,
			'Inbox',
		);

		const initialPwa = createModalDraft();
		const pwaWithProject = applyModalPatch(
			initialPwa,
			applyReminderTextUpdate(initialPwa, projects, { project: 'Work' }),
		);
		const pwa = applyModalPatch(
			pwaWithProject,
			applyReminderTextUpdate(pwaWithProject, projects, { priority: 1 }),
		);

		expect(pwa).toMatchObject({
			content: shared.content,
			project: shared.project,
			priority: shared.priority,
			recurrence: shared.recurrence,
		});
	});

	it('matches shared recurrence replacement', () => {
		const projects = ['Inbox'];
		const recurrence = { frequency: 'daily' as const, hour: 9, minute: 0 };
		const shared = applyReminderDraftContentUpdate(
			{
				content: 'Task Apr 3, 2026',
				dueDate: '2026-04-03',
				recurrence: undefined,
				project: 'Inbox',
				priority: 4,
				hasTime: false,
			},
			{ recurrence, dueDate: null, hasTime: false },
			projects,
			'Inbox',
		);
		const initialPwa = createModalDraft({
			content: 'Task Apr 3, 2026',
			dueDate: '2026-04-03',
		});
		const pwa = applyModalPatch(
			initialPwa,
			applyReminderTextUpdate(initialPwa, projects, {
				recurrence,
				dueDateValue: null,
				hasTime: false,
			}),
		);

		expect(pwa).toMatchObject({
			content: shared.content,
			project: shared.project,
			priority: shared.priority,
			recurrence: shared.recurrence,
			dueDate: '',
			dueTime: '',
		});
	});
});
