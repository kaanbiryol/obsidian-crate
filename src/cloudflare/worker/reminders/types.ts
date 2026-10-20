import type { ScannedReminderRecord } from '@/reminders/core/markdownScan';

export type RemoteReminderRecord = ScannedReminderRecord;

export interface ReminderMutationWorkspace {
	folderPath: string;
}
