import type { AuthPrincipal } from '../auth/authenticate';
import {
	handleCreateRemindersEnrollmentToken,
} from '../notifications/enrollment-handlers';
import {
	handleListSubscriptions,
	handleSubscribe,
	handleTestPush,
	handleUnsubscribe,
} from '../notifications/subscription-handlers';
import { retryPausedNotifications } from '../notifications/retry-handler';

export async function handleNotificationsRoute(
	request: Request,
	db: D1Database,
	path: string,
	method: Request['method'],
	principal: AuthPrincipal,
): Promise<Response | null> {
	if (path === '/notifications/subscribe' && method === 'POST') {
		return await handleSubscribe(request, db, principal.tokenId);
	}
	if (path === '/notifications/subscribe' && method === 'DELETE') {
		return await handleUnsubscribe(request, db, principal.scope === 'reminders' ? principal.tokenId : undefined);
	}
	if (path === '/notifications/subscriptions' && method === 'GET') {
		return await handleListSubscriptions(db);
	}

	if (path === '/notifications/reminders-enrollment-token' && method === 'POST') {
		return await handleCreateRemindersEnrollmentToken(db, request);
	}
	if (path === '/notifications/test' && method === 'POST') {
		return await handleTestPush(db, new URL(request.url).origin);
	}
	if (path === '/notifications/retry' && method === 'POST') return await retryPausedNotifications(db);

	return null;
}
