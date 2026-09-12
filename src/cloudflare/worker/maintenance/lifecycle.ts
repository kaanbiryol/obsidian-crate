import { LEGACY_SWEEP_CUTOFF_KEY, LEGACY_SWEEP_DONE_KEY } from './orphan-sweep';
import { runScheduledMaintenance } from '../maintenance';
import type { Env } from '../types';

async function position(db: D1Database) {
  const [queued, cursor, staged, cutoff, done] = await Promise.all([
    db.prepare('SELECT storage_key FROM object_cleanup_queue ORDER BY created_at LIMIT 1').first<{ storage_key: string }>(),
    db.prepare("SELECT value FROM maintenance_state WHERE key = 'orphan_sweep_cursor'").first<{ value: string }>(),
    db.prepare('SELECT storage_key, expires_at FROM staged_uploads WHERE expires_at IS NOT NULL ORDER BY expires_at, storage_key LIMIT 1').first<{ storage_key: string; expires_at: number }>(),
    db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(LEGACY_SWEEP_CUTOFF_KEY).first<{ value: string }>(),
    db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(LEGACY_SWEEP_DONE_KEY).first(),
  ]);
  return { queued: queued?.storage_key, cursor: cursor?.value, staged: staged && staged.expires_at <= Date.now() ? staged.storage_key : undefined, stagedAt: staged?.expires_at, legacyAt: cutoff && !done ? Number(cutoff.value) + 86400_000 : null };
}

/** Continue only while a bounded storage backlog advances, at most ten passes per episode. */
export async function runMaintenanceEpisode(state: DurableObjectState, env: Env): Promise<void> {
  const pass = (await state.storage.get<number>('maintenancePass') ?? 0) + 1;
  await state.storage.put('maintenancePass', pass);
  if (pass > 10) return;
  const before = await position(env.DB);
  const removed = await runScheduledMaintenance(env);
  const after = await position(env.DB);
  const advancing = Boolean(after.cursor && after.cursor !== before.cursor)
    || Boolean(after.staged && (removed > 0 || after.staged !== before.staged))
    || Boolean(after.queued && (removed > 0 || after.queued !== before.queued));
  if (pass < 10) {
    if (advancing) await state.storage.setAlarm(Date.now() + 5000);
    else {
      const next = [after.legacyAt, after.stagedAt].filter((time): time is number => typeof time === 'number' && time > Date.now());
      if (next.length) await state.storage.setAlarm(Math.min(...next));
    }
  }
}
