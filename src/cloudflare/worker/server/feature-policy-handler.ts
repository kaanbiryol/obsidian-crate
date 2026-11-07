import { corsResponse } from '../http/cors';
import { parseJsonObject } from '../http/request-validation';
import { saveServerState } from '../d1/server-state';
import { resumeScheduledReminderJobs } from '../notifications/outbox';
import { featurePolicy } from './feature-policy';

/** Requests run under the projection coordinator's mutation lock. */
export async function handleFeaturePolicy(request: Request, db: D1Database): Promise<Response> {
	const current = await featurePolicy(db);
	if (request.method === 'GET') return corsResponse(current, 200, { 'Cache-Control': 'no-store' });
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const { feature, enabled, revision } = parsed.value;
	if (!['reading', 'reminders'].includes(String(feature)) || typeof enabled !== 'boolean') return corsResponse({ error: 'Choose a feature and enabled state.' }, 400);
	if (revision !== current.revision) return corsResponse({ error: 'Feature settings changed on another device. Check again before saving.' }, 409);
	const next = { ...current, [String(feature)]: enabled, revision: crypto.randomUUID() };
	await db.batch([
		saveServerState(db, 'features', JSON.stringify(next)),
		...(feature === 'reminders' && enabled && !current.reminders ? [resumeScheduledReminderJobs(db)] : []),
	]);
	return corsResponse(next, 200, { 'Cache-Control': 'no-store' });
}
