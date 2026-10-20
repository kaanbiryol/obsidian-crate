import { corsResponse } from '../cors';

export function expiredReminderOperation(): Response {
	return corsResponse({ code: 'operation_expired', error: 'This change is outside the server’s retry window. An earlier attempt may have synced. Export it and compare your current reminders before restoring missing work.' }, 410);
}
