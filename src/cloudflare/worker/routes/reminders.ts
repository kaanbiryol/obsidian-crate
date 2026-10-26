import { handleNotificationPolicy } from '../notifications/policy';
import { handleCreateReminder } from '../reminders/routes/create';
import { handleDeleteReminder, handleSetReminderCompleted, handleUpdateReminder } from '../reminders/routes/existing-reminder';
import { handleListReminders } from '../reminders/routes/list';
import { handleReorderReminders } from '../reminders/routes/reorder';
import type { Env } from '../types';

export async function handleRemindersRoute(
	request: Request,
	env: Env,
	path: string,
	method: Request['method'],
): Promise<Response | null> {
	const db = env.DB;
	if (path === '/reminders/notification-policy' && ['GET', 'POST', 'PUT'].includes(method)) return handleNotificationPolicy(request, db);

	if (path === '/reminders/list' && method === 'GET') {
		return await handleListReminders(request, env);
	}
	if (path === '/reminders/create' && method === 'POST') {
		return await handleCreateReminder(request, env);
	}
	if (path === '/reminders/update' && method === 'POST') {
		return await handleUpdateReminder(request, env);
	}
	if (path === '/reminders/set-completed' && method === 'POST') {
		return await handleSetReminderCompleted(request, env);
	}
	if (path === '/reminders/delete' && method === 'DELETE') {
		return await handleDeleteReminder(request, env);
	}
	if (path === '/reminders/reorder' && method === 'POST') {
		return await handleReorderReminders(request, env);
	}


	return null;
}
