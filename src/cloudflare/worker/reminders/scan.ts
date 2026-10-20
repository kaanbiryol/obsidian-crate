import {
	getProjectFromPath,
	scanReminderMarkdownContent,
} from '@/reminders/core/markdownScan';
import type { RemoteReminderRecord } from './types';

export { getProjectFromPath };

export function scanReminderMarkdownFile(filePath: string, content: string, remindersFolderPath: string): RemoteReminderRecord[] {
	return scanReminderMarkdownContent(filePath, content, remindersFolderPath).reminders;
}
