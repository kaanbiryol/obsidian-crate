import { queryRows } from '../db';
import { REMINDER_IDENTITY_CONFLICT_ISSUE } from '@/reminders/core/reminder-list';

export class ReminderIdentityConflictError extends Error {
  constructor() { super(REMINDER_IDENTITY_CONFLICT_ISSUE); }
}

export async function assertUniqueReminderSources(db: D1Database, folder: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const duplicates = await queryRows(db.prepare(`SELECT reminder_id FROM reminder_sources
    WHERE file_path >= ? AND file_path < ? AND reminder_id IN (SELECT value FROM json_each(?))
    GROUP BY reminder_id HAVING SUM(occurrences) > 1 LIMIT 1`).bind(`${folder}/`, `${folder}0`, JSON.stringify(ids)));
  if (duplicates.length) throw new ReminderIdentityConflictError();
}
