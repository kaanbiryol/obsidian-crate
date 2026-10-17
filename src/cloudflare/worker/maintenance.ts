import { pruneSharedCheckpoints } from './history-checkpoints';
import { readEncryptionState } from './encryption-state';
import { cleanStagedUploads } from './maintenance/staged-upload-cleanup';
import { cleanStagedBatches } from './maintenance/staged-batch-cleanup';
import { pruneChangelog } from './db';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './maintenance/object-cleanup';
import type { Env } from './types';
import { pruneExpiredTokens, recordMaintenanceRun } from './maintenance/database';
import { pruneFileDeletionReceipts } from './file-delete-audit';
import { pruneReminderOccurrences } from './maintenance/reminder-history';
import { pruneOperationReceipts } from './maintenance/operation-receipts';
import { pruneEncryptedReceiptChunks } from './encrypted-receipt-storage';
import { pruneEncryptionMetadata } from './maintenance/encryption-metadata';

export interface MaintenanceResult { removedObjects: number; backlog: boolean }

/** `backlog` reports a bounded pruning task that filled its batch. */
export async function runScheduledMaintenance(env: Env): Promise<MaintenanceResult> {
  if (await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key='crate_deployment_fence'").first()) return { removedObjects: 0, backlog: false };
	if (['converting', 'resetting'].includes((await readEncryptionState(env.DB))?.mode ?? '')) return { removedObjects: 0, backlog: false };
	const errors: string[] = [];
  let removedObjects = 0, backlog = false;
  const bounded = (task: () => Promise<boolean>) => async () => { if (await task()) backlog = true; };
	const tasks: Array<[string, () => Promise<unknown>]> = [
    ['recover Reading work', async () => {
      if (await env.DB.prepare('SELECT 1 FROM reading_policy WHERE enabled=1').first()) {
        const result = await env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')).fetch('https://do/project', { method: 'POST' });
        if (!result.ok) throw new Error('Reading coordinator unavailable');
      }
    }],
        ['prune shared checkpoints', () => pruneSharedCheckpoints(env.BUCKET, env.DB)],
		['expire file versions', bounded(() => enqueueExpiredFileVersions(env.DB))],
		['drain object cleanup', async () => { removedObjects = await drainObjectCleanupQueue(env.BUCKET, env.DB); }],
		['prune changelog', bounded(() => pruneChangelog(env.DB))],
		['prune file deletion receipts', bounded(() => pruneFileDeletionReceipts(env.DB))],
		['prune obsolete reminder occurrences', () => pruneReminderOccurrences(env.DB)],
		['prune expired operation receipts', bounded(() => pruneOperationReceipts(env.DB))],
		['prune request limits', () => env.DB.prepare('DELETE FROM request_rate_limits WHERE expires_at < ?').bind(Date.now() - 60_000).run()],
		['prune tokens', () => pruneExpiredTokens(env.DB)],
		['clean unfinished uploads', async () => { removedObjects += await cleanStagedUploads(env.BUCKET, env.DB); }],
		['clean unfinished upload batches', async () => { removedObjects += await cleanStagedBatches(env.BUCKET, env.DB); }],
		['prune expired encrypted response chunks', () => pruneEncryptedReceiptChunks(env.DB)],
		['prune unused encryption metadata', () => pruneEncryptionMetadata(env.DB)],
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
  return { removedObjects, backlog };
}
