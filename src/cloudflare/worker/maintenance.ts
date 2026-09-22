import { pruneSharedCheckpoints } from './history-checkpoints';
import { cleanStagedUploads } from './maintenance/staged-upload-cleanup';
import { cleanStagedBatches } from './maintenance/staged-batch-cleanup';
import { pruneChangelog } from './db';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './storage/index';
import type { Env } from './types';
import { pruneExpiredTokens, recordMaintenanceRun } from './maintenance/database';
import { sweepOrphanedManagedObjects } from './maintenance/orphan-sweep';
import { pruneFileDeletionReceipts } from './file-delete-audit';
import { pruneReminderOccurrences, pruneReminderOperations } from './maintenance/reminder-history';

export async function runScheduledMaintenance(env: Env): Promise<number> {
  if (await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key='crate_deployment_fence'").first()) return 0;
	const errors: string[] = [];
  let removedObjects = 0;
	const tasks: Array<[string, () => Promise<unknown>]> = [
    ['recover Reading work', async () => {
      if (await env.DB.prepare('SELECT 1 FROM reading_policy WHERE enabled=1').first()) {
        const result = await env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')).fetch('https://do/project', { method: 'POST' });
        if (!result.ok) throw new Error('Reading coordinator unavailable');
      }
    }],
        ['prune shared checkpoints', () => pruneSharedCheckpoints(env.BUCKET, env.DB)],
		['expire file versions', () => enqueueExpiredFileVersions(env.DB)],
		['drain object cleanup', async () => { removedObjects = await drainObjectCleanupQueue(env.BUCKET, env.DB); }],
		['prune changelog', () => pruneChangelog(env.DB)],
		['prune file deletion receipts', () => pruneFileDeletionReceipts(env.DB)],
		['prune obsolete reminder occurrences', () => pruneReminderOccurrences(env.DB)],
		['prune expired reminder operations', () => pruneReminderOperations(env.DB)],
		['prune request limits', () => env.DB.prepare('DELETE FROM request_rate_limits WHERE expires_at < ?').bind(Date.now() - 60_000).run()],
		['prune tokens', () => pruneExpiredTokens(env.DB)],
		['clean unfinished uploads', async () => { removedObjects += await cleanStagedUploads(env.BUCKET, env.DB); }],
		['clean unfinished upload batches', async () => { removedObjects += await cleanStagedBatches(env.BUCKET, env.DB); }],
		['scan legacy orphaned objects', () => sweepOrphanedManagedObjects(env.BUCKET, env.DB)],
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
  return removedObjects;
}
