import { apiRoutePolicy } from './routes/policy';

/** Uploads coordinate individual Markdown commits after staging; binary changes need no wake. */
export async function affectsNotifications(request: Request): Promise<boolean> {
	return apiRoutePolicy(new URL(request.url).pathname, request.method)?.coordinatesNotifications ?? false;
}
