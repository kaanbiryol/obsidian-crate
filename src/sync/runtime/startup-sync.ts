import { notifyConflicts } from '../conflict/conflict';
import { createLogger } from '../logger';
import type { SyncResult } from '../types';

const logger = createLogger('SyncRuntime');

export interface StartupSyncContext {
	sync: () => Promise<SyncResult>;
	/** False once the runtime replaced the engine or initialization revision this run belongs to. */
	isCurrent: () => boolean;
	/** Ends initialization and queues the vault events that arrived during the sync;
	 * called only while the run is still current. */
	finish: () => void;
}

/** Runs the startup sync. Resolves true once it ran to an outcome (success or failure),
 * false if it was cancelled. */
export function runStartupSync(context: StartupSyncContext): Promise<boolean> {
	return context.sync()
		.then(result => {
			if (result.outcome === 'cancelled') return false;
			notifyConflicts(result.conflicts);
			return true;
		})
		.catch(error => {
			logger.error('Startup sync failed:', error);
			return true;
		})
		.finally(() => {
			if (context.isCurrent()) context.finish();
		});
}
