import { corsResponse } from './cors';
import { parseJsonObject } from './request-validation';
import { parseFeaturePolicy, type FeaturePolicy } from '../../protocol/feature-policy';
import { readServerState, saveServerState } from './server-state';

export async function featurePolicy(db: D1Database): Promise<FeaturePolicy> {
	return parseStoredFeaturePolicy(await readServerState(db, 'features'));
}
/** Parses a stored policy value; authentication loads it with the token. */
export function parseStoredFeaturePolicy(stored: string | null): FeaturePolicy {
	if (stored === null) return { reading: true, reminders: true, revision: null };
	const value = parseFeaturePolicy(JSON.parse(stored));
	// Saved policies always carry a revision.
	if (!value || value.revision === null) throw new Error('Invalid feature policy');
	return value;
}
export async function featureEnabled(db: D1Database, feature: 'reading' | 'reminders'): Promise<boolean> {
	return (await featurePolicy(db))[feature];
}
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
		// Wake dormant alarms without replacing occurrence identity or recipient progress.
		...(feature === 'reminders' && enabled && !current.reminders ? [db.prepare(`INSERT INTO notification_jobs(reminder_id,job_token,operation,payload_json,available_at)
      SELECT reminder_id,schedule_token,'schedule',json_object('reminderId',reminder_id,'content',content,'project',project,'dueDatetime',due_datetime,'resume',json('true')),0
      FROM scheduled_reminders WHERE delivery_failed_at IS NULL
      ON CONFLICT(reminder_id) DO NOTHING`)] : []),
	]);
	return corsResponse(next, 200, { 'Cache-Control': 'no-store' });
}
