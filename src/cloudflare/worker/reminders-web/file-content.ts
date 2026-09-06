import { validateReminderFileContent } from './limits';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import type { buildReminderUpdate } from '@/reminders/data/reminder-repository/shared';
import { getReminderProjectFilePath } from '@/reminders/core/reminderProjectPath';
import {
	appendCreatedReminderBlock,
	buildCreatedReminderBlock,
	buildUpdatedReminderBlock,
	replaceUpdatedReminderBlock,
	setReminderCompletionInContent,
} from '@/reminders/core/markdownReminderMutation';
import {
	deleteReminderBlockFromContent,
	reorderReminderBlocksInContent,
} from '@/reminders/core/markdownReminderFile';
import type { RemoteReminderRecord } from './types';

export { getInitialProjectFileContent } from '@/reminders/core/markdownReminderFile';

export function getProjectFilePath(folderPath: string, project: string): string {
	return getReminderProjectFilePath(folderPath, project);
}

export function createReminderInFileContent(
	fileContent: string,
	params: {
		content: string;
		description?: string;
		dueDate: Date | undefined;
		priority: Priority;
		recurrence?: RecurrenceRule;
		hasTime?: boolean;
		completed?: boolean;
		reminderId: string;
	},
): string {
	return validateReminderFileContent(appendCreatedReminderBlock(fileContent, buildCreatedReminderBlock(params)));
}

export function deleteReminderFromFileContent(fileContent: string, reminder: RemoteReminderRecord): string {
	return deleteReminderBlockFromContent(fileContent, reminder).content;
}

export function updateReminderInFileContent(
	fileContent: string,
	reminder: RemoteReminderRecord,
	update: ReturnType<typeof buildReminderUpdate>,
): string {
	const mutation = buildUpdatedReminderBlock(reminder, update.updates);
	return validateReminderFileContent(replaceUpdatedReminderBlock(fileContent, reminder, mutation).content);
}

export function setReminderCompletedInFileContent(
	fileContent: string,
	reminder: RemoteReminderRecord,
	completed: boolean,
): string {
	if (reminder.completed === completed) return fileContent;
	return validateReminderFileContent(setReminderCompletionInContent(fileContent, reminder, completed).content);
}

export function reorderReminderBlocksInFileContent(fileContent: string, orderedIds: string[]): string {
	return reorderReminderBlocksInContent(fileContent, orderedIds);
}
