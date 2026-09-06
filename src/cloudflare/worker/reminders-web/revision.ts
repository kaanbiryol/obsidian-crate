import { reminderRevision } from '@/reminders/core/reminderRevision';
import { corsResponse } from '../cors';
import type { RemoteReminderRecord } from './types';

export async function checkReminderRevision(body: Record<string, unknown>, reminder: RemoteReminderRecord): Promise<Response | null> {
	if (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
		return corsResponse({ error: 'Reload the reminder before saving', code: 'revision_required' }, 428);
	}
	if (body.expectedRevision !== await reminderRevision(reminder)) {
		return corsResponse({ error: 'Reminder changed on another device. Reload it and review your draft before saving', code: 'version_conflict' }, 409);
	}
	return null;
}
