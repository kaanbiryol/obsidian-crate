import { runNotificationCoordinator } from './coordinator';
import type { Env } from '../types';

const RUN_KEY = 'notificationRun';
const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RUN_PASSES = 10_000;
const MAX_FAILURES = 8;
interface NotificationRun { startedAt: number; passes: number; failures: number }

/** Called under the same DO lock as the mutation, before any file is changed. */
export async function armNotificationCoordinator(state: DurableObjectState): Promise<void> {
	await state.storage.put('projectionCoordinator', true);
	await state.storage.put<NotificationRun>(RUN_KEY, { startedAt: Date.now(), passes: 0, failures: 0 });
	await state.storage.setAlarm(Date.now() + 1);
}

/** A finite processing episode. Unfinished D1 jobs survive an exhausted episode.
 * Returns the episode's run when schedule dispatch is due. */
export async function runBoundedNotificationCoordinator(state: DurableObjectState, env: Env): Promise<NotificationRun | null> {
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
		return await runNotificationCoordinator(state, env) ? run : null;
	} catch (error) {
		await recordFailure(state, run, error);
		return null;
	}
}

/** Called under the lock when the dispatch after `episode`'s pass failed. A change since
 * then armed a new episode, whose own pass dispatches again without this failure. */
export async function recordNotificationDispatchFailure(state: DurableObjectState, episode: NotificationRun, error: unknown): Promise<void> {
	const run = await state.storage.get<NotificationRun>(RUN_KEY);
	if (run?.startedAt === episode.startedAt && run.passes === episode.passes) await recordFailure(state, run, error);
}

async function recordFailure(state: DurableObjectState, run: NotificationRun, error: unknown): Promise<void> {
	run.failures++;
	await state.storage.put(RUN_KEY, run);
	if (run.failures < MAX_FAILURES) await state.storage.setAlarm(Math.min(
		run.startedAt + MAX_RUN_AGE_MS, Date.now() + 60_000 * 2 ** (run.failures - 1),
	));
	else await state.storage.deleteAlarm();
	console.error('Notification processing failed:', error);
}
