import { pruneSharedCheckpoints } from '../sync/history-checkpoints';
import { readEncryptionState } from '../encryption/state';
import { cleanStagedUploads } from './staged-upload-cleanup';
import { cleanStagedBatches } from './staged-batch-cleanup';
import { pruneChangelog } from '../db';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './object-cleanup';
import type { Env } from '../types';
import { pruneExpiredTokens, recordMaintenanceRun } from './database';
import { pruneFileDeletionReceipts } from '../sync/file-delete-audit';
import { pruneReminderOccurrences } from './reminder-history';
import { pruneOperationReceipts } from './operation-receipts';
import { pruneEncryptedReceiptChunks } from '../encryption/receipt-storage';
import { pruneEncryptionMetadata } from './encryption-metadata';
import { wakeProjection } from '../coordinator/coordinator';
import { DEPLOYMENT_FENCE_KEY } from '../../../protocol/deployment-fence';

export interface MaintenanceResult { removedObjects: number; backlog: boolean }

/** `backlog` reports a bounded pruning task that filled its batch. `firstPass`
 * is false for the follow-up passes of one maintenance episode. */
export async function runScheduledMaintenance(env: Env, { firstPass = true }: { firstPass?: boolean } = {}): Promise<MaintenanceResult> {
  if (await env.DB.prepare(`SELECT 1 FROM maintenance_state WHERE key='${DEPLOYMENT_FENCE_KEY}'`).first()) return { removedObjects: 0, backlog: false };
	if ((await readEncryptionState(env.DB))?.mode === 'resetting') return { removedObjects: 0, backlog: false };
	const errors: string[] = [];
  let removedObjects = 0, backlog = false;
  const bounded = (task: () => Promise<boolean>) => async () => { if (await task()) backlog = true; };
	const tasks: Array<[string, () => Promise<unknown>]> = [
    // Once per episode: each wake would otherwise reset a running pass's retry budget.
    ['recover Reading work', async () => {
      if (firstPass && await env.DB.prepare('SELECT 1 FROM reading_policy WHERE enabled=1').first()) {
        if (!await wakeProjection(env)) throw new Error('Reading coordinator unavailable');
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
	];
	// Its reference check scans several whole tables, so run it once per episode
	// rather than on every backlog pass; unused descriptors are small and harmless.
	if (firstPass) tasks.push(['prune unused encryption metadata', () => pruneEncryptionMetadata(env.DB)]);
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
