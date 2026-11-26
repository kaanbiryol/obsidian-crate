import { pruneSharedCheckpoints } from '../sync/history-checkpoints';
import { readEncryptionState } from '../encryption/state';
import { cleanUploadLeases } from './upload-lease-cleanup';
import { deploymentFenceHeld, pruneChangelog } from '../d1/db';
import { drainObjectCleanupQueue, expireFileVersions } from './object-cleanup';
import type { Env } from '../types';
import { pruneExpiredTokens, recordMaintenanceRun } from './database';
import { pruneOrphanReminderCache, pruneReminderOccurrences } from './reminder-history';
import { pruneOperationReceipts } from './operation-receipts';
import { pruneFolderLabels } from '../encryption/folder-labels';
import { wakeProjection } from '../coordinator/coordinator';
import { abortExpiredUploadSessions } from '../sync/upload-sessions';
import { maxFileBytes } from '../server/file-limit';
import { MAX_FILE_SIZE_BYTES } from '../../../protocol/sync-limits';

export interface MaintenanceResult { removedObjects: number; backlog: boolean }

/** `backlog` reports a bounded pruning task that filled its batch. `firstPass` is
 * false for the follow-up passes of one maintenance episode. */
export async function runScheduledMaintenance(env: Env, { firstPass = true }: { firstPass?: boolean } = {}): Promise<MaintenanceResult> {
	const db = env.DB;
	if (await deploymentFenceHeld(db)) return { removedObjects: 0, backlog: false };
	const encryption = await readEncryptionState(db);
	if (encryption?.mode === 'resetting') return { removedObjects: 0, backlog: false };
	const errors: string[] = [];
	let removedObjects = 0, backlog = false;
	const bounded = (task: () => Promise<boolean>) => async () => { if (await task()) backlog = true; };
	const tasks: Array<[string, () => Promise<unknown>]> = [
		// Once per episode: each wake would otherwise reset a running pass's retry budget.
		['recover Reading work', async () => {
			if (firstPass && await db.prepare('SELECT 1 FROM reading_policy WHERE enabled=1').first()) {
				if (!await wakeProjection(env)) throw new Error('Reading coordinator unavailable');
			}
		}],
				['prune shared checkpoints', bounded(() => pruneSharedCheckpoints(db))],
		// Encrypted file descriptors live in these rows, so pruning them releases the descriptors too.
		['prune changelog', bounded(() => pruneChangelog(db))],
		['expire file versions', bounded(() => expireFileVersions(env.BUCKET, db, Date.now()))],
		['drain object cleanup', async () => { removedObjects = await drainObjectCleanupQueue(env.BUCKET, db); }],
		// Unbounded scans of retained history: once per episode, not on every follow-up pass.
		['prune obsolete reminder occurrences', async () => { if (firstPass) await pruneReminderOccurrences(db); }],
		['prune unused reminder cache', async () => { if (firstPass) await pruneOrphanReminderCache(db); }],
		['prune expired operation receipts', bounded(() => pruneOperationReceipts(db, firstPass))],
		['prune request limits', () => db.prepare('DELETE FROM request_rate_limits WHERE expires_at < ?').bind(Date.now() - 60_000).run()],
		['prune tokens', () => pruneExpiredTokens(db)],
		// After expired credentials go, so their folders' labels go in the same pass.
		['prune folder labels', async () => { if (firstPass) await pruneFolderLabels(db).run(); }],
		// Sessions exist only on a self-hosted server whose raised limit accepts them, so others make no R2 call.
		...__CRATE_SELF_HOSTED__ ? [['abort expired upload sessions', bounded(async () => maxFileBytes(env) > MAX_FILE_SIZE_BYTES && await abortExpiredUploadSessions(env.BUCKET))] as [string, () => Promise<unknown>]] : [],
		['clean unfinished uploads', bounded(async () => {
			const { finished, more } = await cleanUploadLeases(env.BUCKET, db);
			removedObjects += finished;
			return more;
		})],
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
	await recordMaintenanceRun(db, errors);
	return { removedObjects, backlog };
}
