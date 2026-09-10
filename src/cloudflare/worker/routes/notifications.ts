import type { AuthPrincipal } from '../authenticate';
import {
	handleCreateRemindersEnrollmentToken,
} from '../notifications';
import {
	handleListSubscriptions,
	handleSubscribe,
	handleTestPush,
	handleUnsubscribe,
} from '../notifications';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handleNotificationsRoute(
	request: Request,
	db: D1Database,
	path: string,
	method: RouteMethod,
	principal: AuthPrincipal,
): Promise<Response | null> {
	if (path === '/notifications/subscribe' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleSubscribe(request, requiredDb, principal.tokenId));
	}
	if (path === '/notifications/subscribe' && method === 'DELETE') {
		return await withDatabase(db, requiredDb => handleUnsubscribe(request, requiredDb, principal.scope === 'reminders' ? principal.tokenId : undefined));
	}
	if (path === '/notifications/subscriptions' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListSubscriptions(requiredDb));
	}

	if (path === '/notifications/reminders-enrollment-token' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleCreateRemindersEnrollmentToken(requiredDb, request));
	}
	if (path === '/notifications/test' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleTestPush(requiredDb, new URL(request.url).origin));
	}

	return null;
}
