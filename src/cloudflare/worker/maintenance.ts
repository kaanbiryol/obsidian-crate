import { pruneChangelog } from './db';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './storage/index';
import type { Env } from './types';
import { drainNotificationJobs } from './notification-outbox';
import { pruneExpiredTokens, recordMaintenanceRun } from './maintenance/database';
import { sweepOrphanedManagedObjects } from './maintenance/orphan-sweep';

export async function runScheduledMaintenance(env: Env): Promise<void> {
	const errors: string[] = [];
	const tasks: Array<[string, () => Promise<unknown>]> = [
		['expire file versions', () => enqueueExpiredFileVersions(env.DB)],
		['drain object cleanup', () => drainObjectCleanupQueue(env.BUCKET, env.DB)],
		['prune changelog', () => pruneChangelog(env.DB)],
		['prune tokens', () => pruneExpiredTokens(env.DB)],
		['drain notification outbox', () => drainNotificationJobs(env)],
		['sweep orphaned objects', () => sweepOrphanedManagedObjects(env.BUCKET, env.DB)],
	];
	for (const [name, task] of tasks) {
		try {
			await task();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${name}: ${message}`);
			console.error(`Scheduled maintenance failed to ${name}:`, message);
		}
	}
	await recordMaintenanceRun(env.DB, errors);
}
