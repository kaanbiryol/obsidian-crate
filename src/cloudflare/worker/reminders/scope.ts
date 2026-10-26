import { getNotificationPolicy } from '../notifications/policy';
import { isMarkdownNoteInFolder } from '../../../protocol/note-paths';

export function isReminderPath(path: string, folder: string | null): boolean {
  return folder !== null && isMarkdownNoteInFolder(path, folder);
}

export async function getReminderFolder(db: D1Database): Promise<string | null> {
  return (await getNotificationPolicy(db))?.folderPath ?? null;
}
