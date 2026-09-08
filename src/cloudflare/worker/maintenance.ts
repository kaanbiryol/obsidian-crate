import { wakeNotificationCoordinator } from './notification-coordinator';
import { pruneChangelog } from './db';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './storage/index';
import type { Env } from './types';
import { pruneExpiredTokens, recordMaintenanceRun } from './maintenance/database';
import { sweepOrphanedManagedObjects } from './maintenance/orphan-sweep';
import { pruneFileDeletionReceipts } from './file-delete-audit';
import { pruneReminderOccurrences } from './maintenance/reminder-history';

export async function runScheduledMaintenance(env: Env): Promise<void> {
	const errors: string[] = [];
	const tasks: Array<[string, () => Promise<unknown>]> = [
		['expire file versions', () => enqueueExpiredFileVersions(env.DB)],
		['drain object cleanup', () => drainObjectCleanupQueue(env.BUCKET, env.DB)],
		['prune changelog', () => pruneChangelog(env.DB)],
		['prune file deletion receipts', () => pruneFileDeletionReceipts(env.DB)],
		['prune obsolete reminder occurrences', () => pruneReminderOccurrences(env.DB)],
		['prune request limits', () => env.DB.prepare('DELETE FROM request_rate_limits WHERE expires_at < ?').bind(Date.now() - 60_000).run()],
		['prune tokens', () => pruneExpiredTokens(env.DB)],
		['wake notification projections', () => wakeNotificationCoordinator(env)],
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
