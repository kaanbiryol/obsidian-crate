import { describe, expect, it } from 'vitest';
import { buildReminderMutationBody } from './reminder-mutation';
import { buildModalDraft } from './reminder-modal-draft';
import { applyReminderTextUpdate, deriveDraftPatchFromContent } from './reminder-state';
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
    it('keeps Inbox through project selection, priority changes, saving and reopening from Work', () => {
        const projects = ['Inbox', 'Work'];
        const draft = createDraft({ project: 'Work', defaultProject: 'Work' });
        Object.assign(draft, applyReminderTextUpdate(draft, projects, { project: 'Inbox' }));
        Object.assign(draft, deriveDraftPatchFromContent(draft, projects));
        Object.assign(draft, applyReminderTextUpdate(draft, projects, { priority: 1 }));
        Object.assign(draft, deriveDraftPatchFromContent(draft, projects));
        const body = buildReminderMutationBody({ config, draft, mode: 'create', projects, selectedProject: 'Work' });
        expect(body).toMatchObject({ content: 'Task', project: 'Inbox', priority: 1 });
        const reopened = buildModalDraft({ id: 'inbox', content: 'Task', project: 'Inbox', priority: 1, completed: false,
            filePath: 'Reminders/Inbox.md', lineNumber: 0 }, 'Work');
        Object.assign(reopened, deriveDraftPatchFromContent(reopened, projects));
        expect(buildReminderMutationBody({ config, draft: reopened, mode: 'edit', projects, selectedProject: 'Work' }))
            .toMatchObject({ content: 'Task', project: 'Inbox', priority: 1 });
    });

    it.each(['Inbox', 'Work'])('preserves literal project mentions when reopening and saving in %s', project => {
        const draft = buildModalDraft({ id: 'one', content: 'Compare #Home with', priority: 4, completed: false,
            project, filePath: `Reminders/${project}.md`, lineNumber: 0 }, project);
        expect(draft.content).toBe(`Compare #Home with #${project}`);
        expect(buildReminderMutationBody({ config, draft, mode: 'edit', projects: ['Inbox', 'Work', 'Home'], selectedProject: project }))
            .toMatchObject({ content: 'Compare #Home with', project });
    });

    it('saves an unmatched calendar phrase as an unscheduled title', () => {
        const content = 'Task February 30 at 9 in the morning';
        expect(buildReminderMutationBody({
            config, mode: 'create', projects: [], selectedProject: null,
            draft: createDraft({ content }),
        })).toMatchObject({ content, dueDate: null, dueDatetime: null, recurrence: undefined });
    });

    it('saves the active chips and clears a stale recurrence when a date replaces it', () => {
        const body = buildReminderMutationBody({
            config, mode: 'edit', projects: ['Personal', 'Work'], selectedProject: null,
            draft: createDraft({
                content: 'Task #Personal #Work ! ! weekly 2026-04-03',
                recurrence: { frequency: 'weekly' },
            }),
        });
        expect(body).toMatchObject({
            content: 'Task #Personal ! weekly', project: 'Work', priority: 1, dueDate: '2026-04-03', recurrence: null,
        });
    });

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
