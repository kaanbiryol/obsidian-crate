import {
	handleCancelReminder,
	handleListScheduled,
	handleScheduleReminder,
} from '../reminder-handlers';
import {
	handleCreateReminder,
	handleDeleteReminder,
	handleListReminders,
	handleReorderReminders,
	handleSetReminderCompleted,
	handleUpdateReminder,
} from '../reminders-web-handlers';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handleRemindersRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB || null;

	if (path === '/reminders/list' && method === 'GET') {
		return await withDatabase(db, () => handleListReminders(request, env));
	}
	if (path === '/reminders/create' && method === 'POST') {
		return await withDatabase(db, () => handleCreateReminder(request, env));
	}
	if (path === '/reminders/update' && method === 'POST') {
		return await withDatabase(db, () => handleUpdateReminder(request, env));
	}
	if (path === '/reminders/set-completed' && method === 'POST') {
		return await withDatabase(db, () => handleSetReminderCompleted(request, env));
	}
	if (path === '/reminders/delete' && method === 'DELETE') {
		return await withDatabase(db, () => handleDeleteReminder(request, env));
	}
	if (path === '/reminders/reorder' && method === 'POST') {
		return await withDatabase(db, () => handleReorderReminders(request, env));
	}
	if (path === '/reminders/schedule' && method === 'POST') return await handleScheduleReminder(request, env);
	if (path === '/reminders/cancel' && method === 'DELETE') return await handleCancelReminder(request, env);
	if (path === '/reminders/scheduled' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListScheduled(requiredDb));
	}

	return null;
}
