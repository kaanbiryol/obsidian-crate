import { buildCreatedReminderBlock, buildReminderCompletionPlan } from '@/reminders/core/markdownReminderMutation';
import { getReminderProjectFilePath } from '@/reminders/core/reminderProjectPath';
import { parseReminderDateValue } from '@/reminders/utils/reminderDate';
import { mergeProject, reorderProjectReminders } from './reminder-list-state';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { ReminderMutationBody, ReminderRecord } from './types';

export function predictSavedReminder(id: string, input: ReminderMutationBody, previous?: ReminderRecord): ReminderRecord {
	const dates = buildCreatedReminderBlock({
		reminderId: id, content: input.content, description: input.description ?? undefined,
		dueDate: parseReminderDateValue(input.dueDatetime ?? input.dueDate ?? undefined, Boolean(input.dueDatetime)),
		priority: input.priority, recurrence: input.recurrence ?? undefined,
		hasTime: input.dueDatetime ? true : input.dueDate ? false : undefined,
	});
	return {
		...previous, id, content: input.content, description: input.description ?? undefined,
		project: input.project, priority: input.priority, completed: previous?.completed ?? false,
		dueDate: previous ? input.dueDate ?? undefined : dates.dueDateKey,
		dueDatetime: previous ? input.dueDatetime ?? undefined : dates.dueDatetime,
		recurrence: input.recurrence ?? undefined,
		filePath: previous?.project === input.project ? previous.filePath : getReminderProjectFilePath(input.folderPath, input.project),
	};
}

export function predictReminderCompletion(reminder: ReminderRecord, completed: boolean): ReminderRecord {
	const plan = buildReminderCompletionPlan({ ...reminder, rawLine: reminder.completed ? '- [x]' : '- [ ]', lineNumber: reminder.lineNumber ?? 0 }, completed);
	return { ...reminder, completed: plan.completed, dueDate: plan.dueDate, dueDatetime: plan.dueDatetime, recurrence: plan.recurrence };
}

export function mergeReminderRecord(reminders: ReminderRecord[], record: ReminderRecord): ReminderRecord[] {
	return reminders.some(item => item.id === record.id)
		? reminders.map(item => item.id === record.id ? record : item)
		: [...reminders, record];
}

/** Render pending changes over confirmed data; rollback never restores an old list snapshot. */
export function applyReminderChanges(reminders: ReminderRecord[], projects: string[], changes: PendingReminderChange[]) {
	let visibleReminders = reminders;
	let visibleProjects = projects;
	for (const change of changes) {
		// Expired attempts are compared with current confirmed data during review.
		if (change.reviewRequired) continue;
		if (change.status === 'failed' && change.kind !== 'save') continue;
		if (change.kind === 'delete') visibleReminders = visibleReminders.filter(item => item.id !== change.recordId);
		else if (change.kind === 'reorder') visibleReminders = reorderProjectReminders(visibleReminders, change.project!, change.orderedIds!);
		else if (change.optimistic) {
			visibleReminders = mergeReminderRecord(visibleReminders, change.optimistic);
			visibleProjects = mergeProject(visibleProjects, change.optimistic.project);
		}
	}
	return { visibleReminders, visibleProjects };
}
