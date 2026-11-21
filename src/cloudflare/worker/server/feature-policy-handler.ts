import { corsResponse } from '../http/cors';
import { parseJsonObject } from '../http/request-validation';
import { saveServerState } from '../d1/server-state';
import { wakeReminderDispatcher } from '../notifications/dispatcher';
import { featurePolicy, parseStoredFeaturePolicy } from './feature-policy';
import type { Env } from '../types';

/** Requests run under the projection coordinator's mutation lock. A read answers with the
 * policy authentication loaded, when the caller has it; a change reads it under the lock. */
export async function handleFeaturePolicy(request: Request, env: Env, loaded?: string | null): Promise<Response> {
	const db = env.DB;
	if (request.method === 'GET') {
		const current = loaded === undefined ? await featurePolicy(db) : parseStoredFeaturePolicy(loaded);
		return corsResponse(current, 200, { 'Cache-Control': 'no-store' });
	}
	const current = await featurePolicy(db);
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const { feature, enabled, readingImages, revision } = parsed.value;
	const images = readingImages === 'save' || readingImages === 'remote';
	if (images ? feature !== undefined || enabled !== undefined : !['reading', 'reminders'].includes(String(feature)) || typeof enabled !== 'boolean') return corsResponse({ error: 'Choose a feature and enabled state.' }, 400);
	if (revision !== current.revision) return corsResponse({ error: 'Feature settings changed on another device. Check again before saving.' }, 409);
	const { readingImages: _previous, ...rest } = current; void _previous;
	// Image saving is the default, so only the other choice is stored.
	const next = images ? { ...rest, ...(readingImages === 'remote' ? { readingImages } : {}), revision: crypto.randomUUID() }
		: { ...current, [String(feature)]: enabled, revision: crypto.randomUUID() };
	await saveServerState(db, 'features', JSON.stringify(next)).run();
	// A paused dispatcher keeps its schedules, attempts and recipient progress but no alarm.
	// Resuming arms it for the earliest one; retry-age limits still apply. Saving Reminders
	// on again rearms it, so a failed wake can be retried.
	if (feature === 'reminders' && enabled) await wakeReminderDispatcher(env);
	return corsResponse(next, 200, { 'Cache-Control': 'no-store' });
}
