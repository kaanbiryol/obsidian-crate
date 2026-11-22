import { runNotificationCoordinator } from './coordinator';
import type { Env } from '../types';
import { isD1DailyLimitError, meterD1Usage, nextD1DailyReset } from '../d1/d1-usage';
import { markRole } from '../coordinator/role-flags';

/** Coordinator storage flag, for runtimes without instance names: its alarm runs notification projection. */
export const PROJECTION_COORDINATOR_KEY = 'projectionCoordinator';
/** Coordinator storage: the reminder parser version projection was last armed for. */
export const PROJECTION_PARSER_VERSION_KEY = 'projectionParserVersion';
const RUN_KEY = 'notificationRun';
/** Set by a pass that wrote a schedule until the dispatcher accepts the new alarm time. */
const DISPATCH_PENDING_KEY = 'notificationDispatchPending';
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RUN_PASSES = 10_000;
/** Passes are stored this often, so an evicted object keeps counting toward the limit. */
const STORED_PASS_INTERVAL = 500;
const MAX_FAILURES = 8;
/** Coordinator storage: `{ day, rowsWritten }`, the D1 rows notification passes wrote this UTC day. */
const DAILY_WRITES_KEY = 'notificationDailyWrites';
/** D1 rows notification passes may write per UTC day before the bulk source scan waits for the
 * next day: setting up a large vault's reminders writes about eight rows per reminder, so a
 * first sync plus that scan would otherwise exceed the Free plan's 100,000. Edited notes keep
 * projecting past it. A self-hosted server has no daily quota. */
export const SOURCE_SCAN_DAILY_WRITE_BUDGET = 40_000;
const utcDay = (now: number) => Math.floor(now / 86_400_000);
/** An arm within this long of a stored fresh episode keeps its start instead of storing a new one. */
const EPISODE_REUSE_MS = 60 * 60 * 1000;
interface NotificationRun { startedAt: number; passes: number; failures: number }
/** The stored run, and the passes since, which stay in memory. A new arm replaces the object. */
interface Episode { stored: NotificationRun; passes: number }
const episodes = new WeakMap<DurableObjectState, Episode>();

async function currentEpisode(state: DurableObjectState): Promise<Episode> {
	let episode = episodes.get(state);
	if (!episode) {
		const stored = await state.storage.get<NotificationRun>(RUN_KEY) ?? { startedAt: Date.now(), passes: 0, failures: 0 };
		episode = { stored, passes: stored.passes };
		episodes.set(state, episode);
	}
	return episode;
}

/** Called under the same DO lock as the mutation, before any file is changed. The episode
 * start and the alarm are stored before the mutation commits. */
export async function armNotificationCoordinator(state: DurableObjectState): Promise<void> {
	await markRole(state, PROJECTION_COORDINATOR_KEY);
	const known = episodes.get(state)?.stored;
	const fresh = known && known.passes === 0 && known.failures === 0 && Date.now() - known.startedAt < EPISODE_REUSE_MS;
	const stored = fresh ? known : { startedAt: Date.now(), passes: 0, failures: 0 };
	if (!fresh) await state.storage.put<NotificationRun>(RUN_KEY, stored);
	episodes.set(state, { stored, passes: 0 });
	await state.storage.setAlarm(Date.now() + 1);
}

/** A finite processing episode. Unfinished D1 jobs survive an exhausted episode.
 * Returns the episode and the earliest due time when the dispatcher needs waking. */
export async function runBoundedNotificationCoordinator(state: DurableObjectState, env: Env): Promise<{ episode: object; dispatchAt: number } | null> {
	const episode = await currentEpisode(state);
	const { stored } = episode;
	if (Date.now() - stored.startedAt >= MAX_RUN_AGE_MS || episode.passes >= MAX_RUN_PASSES || stored.failures >= MAX_FAILURES) {
		await state.storage.deleteAlarm();
		console.error('Notification processing paused after its retry budget; pending jobs are retained until the next change.');
		return null;
	}
	// Counted in memory and stored every few hundred passes, so an object evicted mid-episode
	// keeps its start, its failures and nearly all of its passes.
	episode.passes++;
	if (episode.passes % STORED_PASS_INTERVAL === 0) {
		episode.stored = { ...stored, passes: episode.passes };
		await state.storage.put<NotificationRun>(RUN_KEY, episode.stored);
	}
	const day = utcDay(Date.now());
	const spent = await state.storage.get<{ day: number; rowsWritten: number }>(DAILY_WRITES_KEY);
	const written = spent?.day === day ? spent.rowsWritten : 0;
	const sourceScanPausedUntil = !__CRATE_SELF_HOSTED__ && written >= SOURCE_SCAN_DAILY_WRITE_BUDGET ? nextD1DailyReset() : undefined;
	if (sourceScanPausedUntil !== undefined && episode.stored.startedAt < sourceScanPausedUntil) {
		// Waiting for tomorrow's budget is not processing time: like the D1 daily limit, the
		// episode restarts at the reset, so a scan that needs several days is never abandoned.
		episode.stored = { startedAt: sourceScanPausedUntil, passes: 0, failures: 0 };
		episode.passes = 0;
		await state.storage.put<NotificationRun>(RUN_KEY, episode.stored);
	}
	const meter = meterD1Usage(env.DB);
	try {
		const scheduled = await runNotificationCoordinator(state, { ...env, DB: meter.db }, { sourceScanPausedUntil });
		if (meter.usage.rowsWritten) await state.storage.put(DAILY_WRITES_KEY, { day, rowsWritten: written + meter.usage.rowsWritten });
		if (scheduled.wrote) await state.storage.put(DISPATCH_PENDING_KEY, true);
		if (!await state.storage.get<boolean>(DISPATCH_PENDING_KEY)) return null;
		if (scheduled.dispatchAt === undefined) return null;
		if (scheduled.dispatchAt === null) {
			await state.storage.delete(DISPATCH_PENDING_KEY);
			return null;
		}
		return { episode, dispatchAt: scheduled.dispatchAt };
	} catch (error) {
		// A pass can commit a schedule and then fail; its retry then finds no job for that file,
		// so it would write nothing and never wake the dispatcher. A spurious wake costs one
		// dispatcher request and no D1 query.
		await state.storage.put(DISPATCH_PENDING_KEY, true);
		await recordFailure(state, episode, error);
		return null;
	}
}

/** Called under the lock once the dispatcher accepted the alarm time a pass reported. A
 * later pass that writes a schedule sets the flag again before reporting its own. */
export async function recordNotificationDispatched(state: DurableObjectState): Promise<void> {
	await state.storage.delete(DISPATCH_PENDING_KEY);
}

/** Called under the lock when the dispatch after `episode`'s pass failed. A change since
 * then armed a new episode, whose own pass dispatches again without this failure. */
export async function recordNotificationDispatchFailure(state: DurableObjectState, episode: object, error: unknown): Promise<void> {
	const current = episodes.get(state);
	if (current === episode) await recordFailure(state, current, error);
}

async function recordFailure(state: DurableObjectState, episode: Episode, error: unknown): Promise<void> {
	if (isD1DailyLimitError(error)) {
		// Waiting for the daily reset is not a processing failure: resume then with a full budget.
		const resume = nextD1DailyReset();
		episode.stored = { startedAt: resume, passes: 0, failures: 0 };
		episode.passes = 0;
		await state.storage.put<NotificationRun>(RUN_KEY, episode.stored);
		await state.storage.setAlarm(resume);
		console.error('Notification processing paused until the D1 daily limit resets at 00:00 UTC.');
		return;
	}
	episode.stored = { startedAt: episode.stored.startedAt, passes: episode.passes, failures: episode.stored.failures + 1 };
	await state.storage.put<NotificationRun>(RUN_KEY, episode.stored);
	const { failures, startedAt } = episode.stored;
	if (failures < MAX_FAILURES) await state.storage.setAlarm(Math.min(
		startedAt + MAX_RUN_AGE_MS, Date.now() + 60_000 * 2 ** (failures - 1),
	));
	else await state.storage.deleteAlarm();
	console.error('Notification processing failed:', error);
}
