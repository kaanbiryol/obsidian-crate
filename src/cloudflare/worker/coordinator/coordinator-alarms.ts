import { runReadingExtraction } from '../reading/extraction/jobs';
import { runMaintenanceEpisode } from '../maintenance/lifecycle';
import { recordNotificationDispatchFailure, runBoundedNotificationCoordinator } from '../notifications/lifecycle';
import { dispatchNotificationJobs } from '../notifications/outbox';
import type { StateLock } from './coordinator-requests';
import type { Env } from '../types';

/** Return false for ordinary reminder delivery; coordinator storage identities stay stable. */
export async function runCoordinatorAlarm(state: DurableObjectState, env: Env, withStateLock: StateLock): Promise<boolean> {
	if (await state.storage.get<boolean>('readingCoordinator')) {
		await runReadingExtraction(state, env);
		return true;
	}
	if (await state.storage.get<boolean>('maintenanceCoordinator')) {
		await withStateLock(() => runMaintenanceEpisode(state, env));
		return true;
	}
	if (await state.storage.get<boolean>('projectionCoordinator')) {
		if (!env.BUCKET || !env.REMINDER_ALARMS) throw new Error('Projection bindings unavailable');
		// Wakeups and the final idle/retry decision must share the mutation lock.
		const episode = await withStateLock(() => runBoundedNotificationCoordinator(state, env));
		// Dispatch waits on reminder objects, so commits need not queue behind it. Each
		// reminder object re-checks its job token and source authority.
		if (episode !== null) {
			try { await dispatchNotificationJobs(env, true); }
			catch (error) { await withStateLock(() => recordNotificationDispatchFailure(state, episode, error)); }
		}
		return true;
	}
	return false;
}
