import { notifyConflicts } from '../conflict/conflict';
import { createLogger } from '../logger';
import type { SyncResult } from '../types';

const logger = createLogger('SyncRuntime');

export interface StartupSyncContext {
	sync: () => Promise<SyncResult>;
	/** False once the runtime replaced the engine or initialization revision this run belongs to. */
	isCurrent: () => boolean;
	hasUnsyncedLocalChanges: () => Promise<boolean>;
	automaticSync: () => boolean;
	/** Starts accepting vault events again. */
	resumeEvents: () => void;
	/** Ends initialization; called only while the run is still current. */
	finish: () => void;
}

/** Runs the startup sync and, when local edits slipped in during it, one recovery pass.
 * Resolves true once the startup sync ran to an outcome (success or failure), false if it
 * was cancelled. */
export function runStartupSync(context: StartupSyncContext): Promise<boolean> {
	return context.sync()
		.then(async result => {
			if (result.outcome === 'cancelled') return false;
			notifyConflicts(result.conflicts);
			if (result.success && context.isCurrent()) {
				// Resume event capture before probing so edits made after the
				// startup operation cannot fall into a second blind window.
				context.resumeEvents();
				if (await context.hasUnsyncedLocalChanges() && context.automaticSync()) {
					logger.info('Local changes detected after startup sync; running a recovery pass');
					const recoveryResult = await context.sync();
					if (recoveryResult.outcome === 'cancelled') return false;
					notifyConflicts(recoveryResult.conflicts);
				}
			}
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
