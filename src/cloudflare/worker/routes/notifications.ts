import type { AuthenticatedRouteContext } from '../router';
import type { Env } from '../types';
import {
	handleCreateRemindersEnrollmentToken,
} from '../notifications/enrollment-handlers';
import {
	handleListSubscriptions,
	handleSubscribe,
	handleTestPush,
	handleUnsubscribe,
} from '../notifications/subscription-handlers';

export async function handleNotificationsRoute(
	request: Request,
	env: Env,
	{ path, method, principal }: Pick<AuthenticatedRouteContext, 'path' | 'method' | 'principal'>,
): Promise<Response | null> {
	const db = env.DB;
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

	return null;
}
