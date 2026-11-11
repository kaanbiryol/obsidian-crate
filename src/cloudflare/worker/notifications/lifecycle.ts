import { runNotificationCoordinator } from './coordinator';
import type { Env } from '../types';
import { isD1DailyLimitError, nextD1DailyReset } from '../d1/d1-usage';

/** Coordinator storage flag: its alarm runs notification projection. */
export const PROJECTION_COORDINATOR_KEY = 'projectionCoordinator';
/** Coordinator storage: the reminder parser version projection was last armed for. */
export const PROJECTION_PARSER_VERSION_KEY = 'projectionParserVersion';
const RUN_KEY = 'notificationRun';
/** Set by a pass that wrote a schedule until the dispatcher accepts the new alarm time. */
const DISPATCH_PENDING_KEY = 'notificationDispatchPending';
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RUN_PASSES = 10_000;
const MAX_FAILURES = 8;
interface NotificationRun { startedAt: number; passes: number; failures: number }

/** Called under the same DO lock as the mutation, before any file is changed. */
export async function armNotificationCoordinator(state: DurableObjectState): Promise<void> {
	await state.storage.put(PROJECTION_COORDINATOR_KEY, true);
	await state.storage.put<NotificationRun>(RUN_KEY, { startedAt: Date.now(), passes: 0, failures: 0 });
	await state.storage.setAlarm(Date.now() + 1);
}

/** A finite processing episode. Unfinished D1 jobs survive an exhausted episode.
 * Returns the episode's run and the earliest due time when the dispatcher needs waking. */
export async function runBoundedNotificationCoordinator(state: DurableObjectState, env: Env): Promise<{ episode: NotificationRun; dispatchAt: number } | null> {
	const run = await state.storage.get<NotificationRun>(RUN_KEY)
		?? { startedAt: Date.now(), passes: 0, failures: 0 };
	if (Date.now() - run.startedAt >= MAX_RUN_AGE_MS || run.passes >= MAX_RUN_PASSES || run.failures >= MAX_FAILURES) {
		await state.storage.deleteAlarm();
		console.error('Notification processing paused after its retry budget; pending jobs are retained until the next change.');
		return null;
	}
	run.passes++;
	await state.storage.put(RUN_KEY, run);
	try {
		const scheduled = await runNotificationCoordinator(state, env);
		if (scheduled.wrote) await state.storage.put(DISPATCH_PENDING_KEY, true);
		if (!await state.storage.get<boolean>(DISPATCH_PENDING_KEY)) return null;
		if (scheduled.dispatchAt === undefined) return null;
		if (scheduled.dispatchAt === null) {
			await state.storage.delete(DISPATCH_PENDING_KEY);
			return null;
		}
		return { episode: run, dispatchAt: scheduled.dispatchAt };
	} catch (error) {
		await recordFailure(state, run, error);
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
export async function recordNotificationDispatchFailure(state: DurableObjectState, episode: NotificationRun, error: unknown): Promise<void> {
	const run = await state.storage.get<NotificationRun>(RUN_KEY);
	if (run?.startedAt === episode.startedAt && run.passes === episode.passes) await recordFailure(state, run, error);
}

async function recordFailure(state: DurableObjectState, run: NotificationRun, error: unknown): Promise<void> {
	if (isD1DailyLimitError(error)) {
		// Waiting for the daily reset is not a processing failure: resume then with a full budget.
		const resume = nextD1DailyReset();
		await state.storage.put<NotificationRun>(RUN_KEY, { startedAt: resume, passes: 0, failures: 0 });
		await state.storage.setAlarm(resume);
		console.error('Notification processing paused until the D1 daily limit resets at 00:00 UTC.');
		return;
	}
	run.failures++;
	await state.storage.put(RUN_KEY, run);
	if (run.failures < MAX_FAILURES) await state.storage.setAlarm(Math.min(
		run.startedAt + MAX_RUN_AGE_MS, Date.now() + 60_000 * 2 ** (run.failures - 1),
	));
	else await state.storage.deleteAlarm();
	console.error('Notification processing failed:', error);
}
