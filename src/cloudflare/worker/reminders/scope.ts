import { getNotificationPolicy } from '../notifications/policy';
import { isReminderNotePath } from '../../../protocol/reminder-archive-path';

export function isReminderPath(path: string, folder: string | null): boolean {
	return folder !== null && isReminderNotePath(path, folder);
}

export async function getReminderFolder(db: D1Database): Promise<string | null> {
	return (await getNotificationPolicy(db))?.folderPath ?? null;
}
