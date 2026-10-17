import { runScheduledMaintenance } from '../maintenance';
import type { Env } from '../types';

const MAX_PASSES = 10;
// Retained-object draining continues past MAX_PASSES; at 500 objects per pass
// this bounds one episode at 100,000 deletions.
const MAX_DRAIN_PASSES = 200;

async function position(db: D1Database) {
  const [queued, staged, batch] = await Promise.all([
    db.prepare('SELECT storage_key FROM object_cleanup_queue ORDER BY rowid LIMIT 1').first<{ storage_key: string }>(),
    db.prepare('SELECT storage_key, expires_at FROM staged_uploads WHERE expires_at IS NOT NULL ORDER BY expires_at, storage_key LIMIT 1').first<{ storage_key: string; expires_at: number }>(),
    db.prepare('SELECT id, expires_at FROM staged_upload_batches WHERE expires_at IS NOT NULL ORDER BY expires_at, id LIMIT 1').first<{ id: string; expires_at: number }>(),
  ]);
  return { queued: queued?.storage_key,
    staged: staged && staged.expires_at <= Date.now() ? staged.storage_key : undefined, stagedAt: staged?.expires_at,
    batch: batch && batch.expires_at <= Date.now() ? batch.id : undefined, batchAt: batch?.expires_at };
}

/** Continue only while a bounded storage backlog advances, at most ten passes per
 * episode unless the object cleanup queue head is still moving. */
export async function runMaintenanceEpisode(state: DurableObjectState, env: Env): Promise<void> {
  const pass = (await state.storage.get<number>('maintenancePass') ?? 0) + 1;
  await state.storage.put('maintenancePass', pass);
  if (pass > MAX_DRAIN_PASSES || pass > MAX_PASSES && !await state.storage.get<boolean>('maintenanceDraining')) return;
  const before = await position(env.DB);
  const removed = await runScheduledMaintenance(env);
  const after = await position(env.DB);
  const draining = Boolean(after.queued && after.queued !== before.queued);
  await state.storage.put('maintenanceDraining', draining);
  const advancing = Boolean(after.staged && (removed > 0 || after.staged !== before.staged))
    || Boolean(after.batch && (removed > 0 || after.batch !== before.batch))
    || Boolean(after.queued && (removed > 0 || after.queued !== before.queued));
  if (pass < (draining ? MAX_DRAIN_PASSES : MAX_PASSES)) {
    if (advancing) await state.storage.setAlarm(Date.now() + 5000);
    else {
      const next = [after.stagedAt, after.batchAt].filter((time): time is number => typeof time === 'number' && time > Date.now());
      if (next.length) await state.storage.setAlarm(Math.min(...next));
    }
  }
}
