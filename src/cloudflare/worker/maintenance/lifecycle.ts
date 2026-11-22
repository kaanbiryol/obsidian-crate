import { runScheduledMaintenance } from './run';
import type { Env } from '../types';
import { markRole } from '../coordinator/role-flags';
import { FILE_VERSION_CUTOFF_SQL } from '../sync/storage';
import { isD1DailyLimitError, meterD1Usage, nextD1DailyReset } from '../d1/d1-usage';

/** Maintenance role storage flag, for runtimes without instance names: its alarm runs maintenance episodes. */
export const MAINTENANCE_COORDINATOR_KEY = 'maintenanceCoordinator';
/** Maintenance role storage: passes run in the current episode. */
const MAINTENANCE_PASS_KEY = 'maintenancePass';
/** Maintenance role storage: whether the last pass was still draining retained objects. */
const DRAINING_KEY = 'maintenanceDraining';
const MAX_PASSES = 10;
// Retained-object draining (the cleanup queue or expired versions) continues past
// MAX_PASSES; at 500 objects per pass this bounds one episode at 100,000 deletions.
const MAX_DRAIN_PASSES = 200;
/** Maintenance role storage: `{ day, rowsWritten }`, the D1 rows maintenance wrote this UTC day. */
const DAILY_WRITES_KEY = 'maintenanceDailyWrites';
/** D1 rows maintenance may write per UTC day, a fifth of the Free plan's 100,000, so a
 * backlog spreads over days instead of blocking sync. A pass that starts under it may
 * finish above it. */
export const MAINTENANCE_DAILY_WRITE_BUDGET = 20_000;
const utcDay = (now: number) => Math.floor(now / 86_400_000);

async function position(db: D1Database) {
	const [queued, expired, lease] = await Promise.all([
		db.prepare('SELECT storage_key FROM object_cleanup_queue ORDER BY storage_key LIMIT 1').first<{ storage_key: string }>(),
		db.prepare(`SELECT storage_key FROM file_versions WHERE kept_at <= ${FILE_VERSION_CUTOFF_SQL} ORDER BY kept_at LIMIT 1`).bind(Date.now()).first<{ storage_key: string }>(),
		db.prepare('SELECT id, expires_at FROM upload_leases WHERE expires_at IS NOT NULL ORDER BY expires_at, id LIMIT 1').first<{ id: string; expires_at: number }>(),
	]);
	return { queued: queued?.storage_key, expired: expired?.storage_key,
		lease: lease && lease.expires_at <= Date.now() ? lease.id : undefined, leaseAt: lease?.expires_at };
}

/** Called under the maintenance role's lock. A scheduled episode keeps its alarm and pass count. */
export async function armMaintenanceCoordinator(state: DurableObjectState): Promise<void> {
	await markRole(state, MAINTENANCE_COORDINATOR_KEY);
	if (await state.storage.getAlarm() === null) {
		await state.storage.put(MAINTENANCE_PASS_KEY, 0);
		await state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
	}
}

/** Continue only while a bounded storage or pruning backlog advances, at most ten
 * passes per episode unless the object cleanup queue or the expired versions are still
 * being removed. */
export async function runMaintenanceEpisode(state: DurableObjectState, env: Env): Promise<void> {
	const pass = (await state.storage.get<number>(MAINTENANCE_PASS_KEY) ?? 0) + 1;
	const wasDraining = await state.storage.get<boolean>(DRAINING_KEY);
	if (pass > MAX_DRAIN_PASSES || pass > MAX_PASSES && !wasDraining) {
		await state.storage.put(MAINTENANCE_PASS_KEY, pass);
		return;
	}
	const day = utcDay(Date.now());
	const spent = await state.storage.get<{ day: number; rowsWritten: number }>(DAILY_WRITES_KEY);
	const written = spent?.day === day ? spent.rowsWritten : 0;
	// Out of today's budget: the episode resumes with this pass after the daily reset. A
	// self-hosted server has no daily D1 quota, so its cleanup never waits.
	if (!__CRATE_SELF_HOSTED__ && written >= MAINTENANCE_DAILY_WRITE_BUDGET) {
		await state.storage.setAlarm(nextD1DailyReset());
		return;
	}
	await state.storage.put(MAINTENANCE_PASS_KEY, pass);
	const meter = meterD1Usage(env.DB);
	let before: Awaited<ReturnType<typeof position>>, after: typeof before, result: Awaited<ReturnType<typeof runScheduledMaintenance>>;
	try {
		before = await position(env.DB);
		result = await runScheduledMaintenance({ ...env, DB: meter.db }, { firstPass: pass === 1 });
		after = await position(env.DB);
	} catch (error) {
		if (!isD1DailyLimitError(error)) throw error;
		// The account's allowance is spent, whoever spent it: retry this pass after the reset
		// instead of letting alarm retries fail against it.
		await state.storage.put(MAINTENANCE_PASS_KEY, pass - 1);
		await state.storage.put(DAILY_WRITES_KEY, { day, rowsWritten: MAINTENANCE_DAILY_WRITE_BUDGET });
		await state.storage.setAlarm(nextD1DailyReset());
		return;
	}
	if (meter.usage.rowsWritten) await state.storage.put(DAILY_WRITES_KEY, { day, rowsWritten: written + meter.usage.rowsWritten });
	const { removedObjects: removed, backlog } = result;
	const draining = Boolean(after.queued && after.queued !== before.queued || after.expired && after.expired !== before.expired);
	if (draining !== Boolean(wasDraining)) await state.storage.put(DRAINING_KEY, draining);
	const advancing = backlog || Boolean(after.lease && (removed > 0 || after.lease !== before.lease))
		|| Boolean(after.queued && (removed > 0 || after.queued !== before.queued));
	if (pass < (draining ? MAX_DRAIN_PASSES : MAX_PASSES)) {
		if (advancing) await state.storage.setAlarm(Date.now() + 5000);
		else {
			if (after.leaseAt !== undefined && after.leaseAt > Date.now()) await state.storage.setAlarm(after.leaseAt);
		}
	}
}
