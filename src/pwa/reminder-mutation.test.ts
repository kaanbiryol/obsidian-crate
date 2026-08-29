import { describe, expect, it } from 'vitest';
import { buildReminderMutationBody } from './reminder-mutation';
import type { ModalDraft, StoredConfig } from './types';

const config: StoredConfig = {
	folderPath: 'Reminders',
	upcomingDays: 7,
	allDayNotificationTime: '09:00',
};

function createDraft(overrides: Partial<ModalDraft> = {}): ModalDraft {
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

describe('buildReminderMutationBody', () => {
	it('normalizes inline project, priority, and date metadata from content', () => {
		const body = buildReminderMutationBody({
			config,
			draft: createDraft({
				content: '  Finish report  #Work  ! 2026-04-03  ',
				project: 'Inbox',
				priority: 4,
			}),
			mode: 'create',
			projects: ['Inbox', 'Work'],
			selectedProject: null,
		});

		expect(body).toMatchObject({
			content: 'Finish report',
			project: 'Work',
			priority: 1,
			dueDate: '2026-04-03',
			dueDatetime: null,
			recurrence: undefined,
		});
	});

	it('uses draft date fields when content has no date or recurrence', () => {
		const body = buildReminderMutationBody({
			config,
			draft: createDraft({
				content: 'Call Ana',
				dueDate: '2026-04-03',
				dueTime: '14:30',
			}),
			mode: 'create',
			projects: ['Inbox'],
			selectedProject: 'Personal',
		});

		expect(body.project).toBe('Inbox');
		expect(body.dueDate).toBeNull();
		expect(body.dueDatetime).toBe(new Date('2026-04-03T14:30').toISOString());
	});

	it('sends null recurrence for edits that clear recurrence', () => {
		const body = buildReminderMutationBody({
			config,
			draft: createDraft({
				content: 'Call Ana',
				recurrence: undefined,
			}),
			mode: 'edit',
			projects: ['Inbox'],
			selectedProject: null,
		});

		expect(body.recurrence).toBeNull();
	});
});
