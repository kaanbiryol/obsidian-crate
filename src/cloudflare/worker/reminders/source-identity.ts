import type { SqlGuard } from '../db';
import { REMINDER_IDENTITY_CONFLICT_ISSUE } from '@/reminders/core/reminder-list';

export class ReminderIdentityConflictError extends Error {
	constructor() { super(REMINDER_IDENTITY_CONFLICT_ISSUE); }
}

/** True when one of `ids` occurs more than once in the folder's committed notes. */
export function duplicateReminderSourcesSql(folder: string, ids: readonly string[]): SqlGuard {
	return { sql: `EXISTS (SELECT reminder_id FROM reminder_sources
    WHERE file_path >= ? AND file_path < ? AND reminder_id IN (SELECT value FROM json_each(?))
    GROUP BY reminder_id HAVING SUM(occurrences) > 1)`, args: [`${folder}/`, `${folder}0`, JSON.stringify(ids)] };
}

export async function assertUniqueReminderSources(db: D1Database, folder: string, ids: string[]): Promise<void> {
	if (!ids.length) return;
	const duplicate = duplicateReminderSourcesSql(folder, ids);
	if (await db.prepare(`SELECT 1 WHERE ${duplicate.sql}`).bind(...duplicate.args).first()) throw new ReminderIdentityConflictError();
}
