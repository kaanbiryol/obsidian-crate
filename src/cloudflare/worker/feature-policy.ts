import { corsResponse } from './cors';
import { parseJsonObject } from './utils';

export interface FeaturePolicy { reading: boolean; reminders: boolean; revision: string | null }
export const FEATURE_POLICY_KEY = 'crate_feature_policy';
export async function featurePolicy(db: D1Database): Promise<FeaturePolicy> {
  const row = await db.prepare('SELECT value FROM maintenance_state WHERE key=?').bind(FEATURE_POLICY_KEY).first<{ value: string }>();
  if (!row) return { reading: true, reminders: true, revision: null };
  const value = JSON.parse(row.value) as FeaturePolicy;
  if (typeof value.reading !== 'boolean' || typeof value.reminders !== 'boolean' || typeof value.revision !== 'string') throw new Error('Invalid feature policy');
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
    db.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime(\'now\')').bind(FEATURE_POLICY_KEY, JSON.stringify(next)),
    // Wake dormant alarms without replacing occurrence identity or recipient progress.
    ...(feature === 'reminders' && enabled && !current.reminders ? [db.prepare(`INSERT INTO notification_jobs(reminder_id,job_token,operation,payload_json,available_at)
      SELECT reminder_id,schedule_token,'schedule',json_object('reminderId',reminder_id,'content',content,'project',project,'dueDatetime',due_datetime,'resume',json('true')),0
      FROM scheduled_reminders WHERE delivery_failed_at IS NULL
      ON CONFLICT(reminder_id) DO NOTHING`)] : []),
  ]);
  return corsResponse(next, 200, { 'Cache-Control': 'no-store' });
}
