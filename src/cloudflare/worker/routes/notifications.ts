import {
	handleCreateEnrollmentToken,
	handleCreateRemindersEnrollmentToken,
	handleListSubscriptions,
	handleSubscribe,
	handleTestPush,
	handleUnsubscribe,
} from '../push-handlers';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handleNotificationsRoute(
	request: Request,
	db: D1Database | null,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	if (path === '/notifications/subscribe' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleSubscribe(request, requiredDb));
	}
	if (path === '/notifications/subscribe' && method === 'DELETE') {
		return await withDatabase(db, requiredDb => handleUnsubscribe(request, requiredDb));
	}
	if (path === '/notifications/subscriptions' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListSubscriptions(requiredDb));
	}
	if (path === '/notifications/enrollment-token' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleCreateEnrollmentToken(requiredDb));
	}
	if (path === '/notifications/reminders-enrollment-token' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleCreateRemindersEnrollmentToken(requiredDb));
	}
	if (path === '/notifications/test' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleTestPush(requiredDb));
	}

	return null;
}
