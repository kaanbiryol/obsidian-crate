import { buildStoredReminderDates } from '@/reminders/utils/reminderDate';
import { parseReminderContent } from '@/reminders/utils/reminderParser';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import type { ModalDraft, ModalMode, ReminderMutationBody, StoredConfig } from './types';

export function buildReminderMutationBody({
	config,
	draft,
	mode,
	projects,
	selectedProject,
}: {
	config: Pick<StoredConfig, 'folderPath' | 'allDayNotificationTime'>;
	draft: ModalDraft;
	mode: ModalMode;
	projects: string[];
	selectedProject: string | null;
}): ReminderMutationBody {
	const createDefaultProject = selectedProject ?? 'Inbox';
	const projectOptions = ['Inbox', ...projects.filter((project) => project !== 'Inbox')];
	const rawContent = draft.content.replace(/\s+/g, ' ').trim();
	const parsed = parseReminderContent(rawContent, projectOptions);
	const project = parsed.project || draft.project.trim() || createDefaultProject;
	const priority: 1 | 4 = parsed.priorityPart ? parsed.priority : draft.priority === 1 ? 1 : 4;
	const content = (parsed.cleanContent || rawContent).replace(/\s+/g, ' ').trim();
	const recurrence = normalizeRecurrenceRule(parsed.recurrence || draft.recurrence);
	let dueDate: string | null = null;
	let dueDatetime: string | null = null;

	if (parsed.dueDate) {
		const parsedDates = buildStoredReminderDates(parsed.dueDate, parsed.hasTime);
		dueDate = parsedDates.dueDate ?? null;
		dueDatetime = parsedDates.dueDatetime ?? null;
	} else if (!recurrence) {
		const rawDate = draft.dueDate.trim();
		const rawTime = draft.dueTime.trim();
		if (rawDate && rawTime) dueDatetime = new Date(`${rawDate}T${rawTime}`).toISOString();
		else if (rawDate) dueDate = rawDate;
	}

	return {
		folderPath: config.folderPath,
		allDayNotificationTime: config.allDayNotificationTime,
		content,
		description: draft.description.trim() || null,
		project,
		priority,
		dueDate,
		dueDatetime,
		recurrence: recurrence ?? (mode === 'edit' ? null : undefined),
	};
}
