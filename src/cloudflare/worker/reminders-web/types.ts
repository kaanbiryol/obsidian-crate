import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';

export interface RemoteReminderRecord {
	id: string;
	content: string;
	description?: string;
	dueDate?: string;
	dueDatetime?: string;
	priority: Priority;
	completed: boolean;
	project: string;
	recurrence?: RecurrenceRule;
	filePath: string;
	lineNumber: number;
	rawLine: string;
	contentHash: string;
}

export interface ReminderFileRecord {
	path: string;
	content: string;
}

export interface ReminderWorkspace {
	folderPath: string;
	files: Map<string, ReminderFileRecord>;
	reminders: RemoteReminderRecord[];
	projects: string[];
}

export interface ReminderMutationWorkspace {
	folderPath: string;
	allDayNotificationTime?: string | null;
}
