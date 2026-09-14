import { getNotificationPolicy } from './notification-policy';

export function isReminderPath(path: string, folder: string | null): boolean {
  return folder !== null && path.startsWith(`${folder}/`) && path.toLowerCase().endsWith('.md');
}

export async function getReminderFolder(db: D1Database): Promise<string | null> {
  return (await getNotificationPolicy(db))?.folderPath ?? null;
}
