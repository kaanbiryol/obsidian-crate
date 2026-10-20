import { reminderRevision } from '@/reminders/core/reminderRevision';
import { corsResponse } from '../cors';
import type { RemoteReminderRecord } from './types';
import { isSha256Hex } from '@/platform/validation';

export async function checkReminderRevision(body: Record<string, unknown>, reminder: RemoteReminderRecord): Promise<Response | null> {
	if (!isSha256Hex(body.expectedRevision)) {
		return corsResponse({ error: 'Reload the reminder before saving', code: 'revision_required' }, 428);
	}
	if (body.expectedRevision !== await reminderRevision(reminder)) {
		return corsResponse({ error: 'Reminder changed on another device. Reload it and review your draft before saving', code: 'version_conflict' }, 409);
	}
	return null;
}
