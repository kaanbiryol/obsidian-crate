import { assertReminderMutationInput, ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { resolveReminderSubmission } from '@/reminders/core/reminderSubmission';
import type { ModalDraft, ModalMode, ReminderMutationBody, StoredConfig } from '../../types';
import { DEFAULT_PROJECT, projectOptionsWithDefault } from '@/reminders/core/constants';

export function buildReminderMutationBody({
	config,
	draft,
	mode,
	projects,
	selectedProject,
}: {
	config: Pick<StoredConfig, 'folderPath'>;
	draft: ModalDraft;
	mode: ModalMode;
	projects: string[];
	selectedProject: string | null;
}): ReminderMutationBody {
	const createDefaultProject = selectedProject ?? DEFAULT_PROJECT;
	const projectOptions = projectOptionsWithDefault(projects);
	const rawContent = draft.content.replace(/\s+/g, ' ').trim();
	const rawDate = draft.dueDate.trim();
	const rawTime = draft.dueTime.trim();
	const resolved = resolveReminderSubmission({
		content: rawContent,
		description: draft.description,
		projects: projectOptions,
		project: draft.project.trim() || createDefaultProject,
		priority: draft.priority === 1 ? 1 : 4,
		dueDate: rawDate && rawTime ? `${rawDate}T${rawTime}` : rawDate || null,
		hasTime: Boolean(rawDate && rawTime),
		recurrence: draft.recurrence,
		mode,
		originalDueDatetime: draft.originalDueDatetime,
	});
	if (!resolved) throw new ReminderInputError('content', 'Enter a reminder title.');
	const body = {
		folderPath: config.folderPath,
		content: resolved.content.replace(/\s+/g, ' ').trim(),
		description: resolved.description ?? null,
		project: resolved.project,
		priority: resolved.priority,
		// Timed picker fields use dueDatetime alone; dates parsed from the title
		// retain the API's existing companion date key.
		dueDate: resolved.hasTime && resolved.dateSource !== 'text' ? null : resolved.dueDate ?? null,
		dueDatetime: resolved.dueDatetime ?? null,
		recurrence: resolved.recurrence ?? (mode === 'edit' ? null : undefined),
	};
	assertReminderMutationInput(body, mode === 'edit' ? 'update' : 'create');
	return body;
}
