import { runReadingExtraction } from './reading/extraction/jobs';
import { runMaintenanceEpisode } from './maintenance/lifecycle';
import { runBoundedNotificationCoordinator } from './notification-lifecycle';
import type { StateLock } from './coordinator-requests';
import type { Env } from './types';

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
		await withStateLock(() => runBoundedNotificationCoordinator(state, env));
		return true;
	}
	return false;
}
