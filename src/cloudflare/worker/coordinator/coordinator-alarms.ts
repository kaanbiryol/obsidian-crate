import { READING_COORDINATOR_KEY, runReadingExtraction } from '../reading/extraction/jobs';
import { MAINTENANCE_COORDINATOR_KEY, runMaintenanceEpisode } from '../maintenance/lifecycle';
import { PROJECTION_COORDINATOR_KEY, recordNotificationDispatched, recordNotificationDispatchFailure, runBoundedNotificationCoordinator } from '../notifications/lifecycle';
import { DISPATCHER_KEY, runReminderDispatch, wakeReminderDispatcher } from '../notifications/dispatcher';
import type { StateLock } from './coordinator-requests';
import type { Env } from '../types';

/** Runs the alarm of whichever role this instance is. Returns false for an instance with
 * no role; coordinator storage identities stay stable. */
export async function runCoordinatorAlarm(state: DurableObjectState, env: Env, withStateLock: StateLock): Promise<boolean> {
	if (await state.storage.get<boolean>(DISPATCHER_KEY)) {
		await runReminderDispatch(state, env, withStateLock);
		return true;
	}
	if (await state.storage.get<boolean>(READING_COORDINATOR_KEY)) {
		await runReadingExtraction(state, env);
		return true;
	}
	if (await state.storage.get<boolean>(MAINTENANCE_COORDINATOR_KEY)) {
		await withStateLock(() => runMaintenanceEpisode(state, env));
		return true;
	}
	if (await state.storage.get<boolean>(PROJECTION_COORDINATOR_KEY)) {
		if (!env.BUCKET || !env.REMINDER_ALARMS) throw new Error('Projection bindings unavailable');
		// Wakeups and the final idle/retry decision must share the mutation lock.
		const due = await withStateLock(() => runBoundedNotificationCoordinator(state, env));
		// Waking the dispatcher waits on another object, so commits need not queue behind it.
		// The dispatcher re-checks source authority before each delivery.
		if (due !== null) {
			try {
				await wakeReminderDispatcher(env, due.dispatchAt);
				await withStateLock(() => recordNotificationDispatched(state));
			} catch (error) { await withStateLock(() => recordNotificationDispatchFailure(state, due.episode, error)); }
		}
		return true;
	}
	return false;
}
