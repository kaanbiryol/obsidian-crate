import {
	getProjectFromPath,
	scanReminderMarkdownContent,
} from '@/reminders/core/markdownScan';
import type { RemoteReminderRecord } from './types';

export { getProjectFromPath };

export function scanReminderMarkdownFile(filePath: string, content: string, remindersFolderPath: string): RemoteReminderRecord[] {
	return scanReminderMarkdownContent(filePath, content, remindersFolderPath).reminders;
}

export function toReminderPayload(reminder: RemoteReminderRecord): Record<string, unknown> {
	return {
		id: reminder.id,
		content: reminder.content,
		description: reminder.description,
		dueDate: reminder.dueDate,
		dueDatetime: reminder.dueDatetime,
		priority: reminder.priority,
		completed: reminder.completed,
		project: reminder.project,
		recurrence: reminder.recurrence,
		filePath: reminder.filePath,
		lineNumber: reminder.lineNumber,
	};
}
