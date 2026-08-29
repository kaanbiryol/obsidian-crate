import { describe, expect, it } from 'vitest';
import { applyReminderDraftContentUpdate } from '@/reminders/core/reminderDraft';
import type { ReminderDraftContentState } from '@/reminders/core/reminderDraft';
import { applyReminderTextUpdate } from './reminder-state';
import type { ModalDraft } from './types';

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

describe('PWA reminder draft parity', () => {
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
