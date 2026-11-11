import { corsResponse } from '../http/cors';
import { parseJsonObject } from '../http/request-validation';
import { saveServerState } from '../d1/server-state';
import { wakeReminderDispatcher } from '../notifications/dispatcher';
import { featurePolicy } from './feature-policy';
import type { Env } from '../types';

/** Requests run under the projection coordinator's mutation lock. */
export async function handleFeaturePolicy(request: Request, env: Env): Promise<Response> {
	const db = env.DB;
	const current = await featurePolicy(db);
	if (request.method === 'GET') return corsResponse(current, 200, { 'Cache-Control': 'no-store' });
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const { feature, enabled, revision } = parsed.value;
	if (!['reading', 'reminders'].includes(String(feature)) || typeof enabled !== 'boolean') return corsResponse({ error: 'Choose a feature and enabled state.' }, 400);
	if (revision !== current.revision) return corsResponse({ error: 'Feature settings changed on another device. Check again before saving.' }, 409);
	const next = { ...current, [String(feature)]: enabled, revision: crypto.randomUUID() };
	await saveServerState(db, 'features', JSON.stringify(next)).run();
	// A paused dispatcher keeps its schedules, attempts and recipient progress but no alarm.
	// Resuming arms it for the earliest one; retry-age limits still apply. Saving Reminders
	// on again rearms it, so a failed wake can be retried.
	if (feature === 'reminders' && enabled) await wakeReminderDispatcher(env);
	return corsResponse(next, 200, { 'Cache-Control': 'no-store' });
}
