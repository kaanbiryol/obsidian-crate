import { pruneSharedCheckpoints } from '../sync/history-checkpoints';
import { readEncryptionState } from '../encryption/state';
import { cleanStagedUploads } from './staged-upload-cleanup';
import { cleanStagedBatches } from './staged-batch-cleanup';
import { pruneChangelog } from '../db';
import { drainObjectCleanupQueue, enqueueExpiredFileVersions } from './object-cleanup';
import type { Env } from '../types';
import { pruneExpiredTokens, recordMaintenanceRun } from './database';
import { pruneFileDeletionReceipts } from '../sync/file-delete-audit';
import { pruneReadingRemovals } from '../reading/library-index';
import { pruneReminderOccurrences } from './reminder-history';
import { pruneOperationReceipts } from './operation-receipts';
import { pruneEncryptedReceiptChunks } from '../encryption/receipt-storage';
import { pruneEncryptionMetadata, releaseExpiredVersionDescriptors, releasePrunedChangelogDescriptors } from './encryption-metadata';
import { wakeProjection } from '../coordinator/coordinator';
import { countD1Queries } from '../d1-query-count';
import { D1_QUERIES_PER_INVOCATION } from '../platform-limits';
import { DEPLOYMENT_FENCE_KEY } from '../../../protocol/deployment-fence';

export interface MaintenanceResult { removedObjects: number; backlog: boolean }

/** `backlog` reports a bounded pruning task that filled its batch or a task left
 * for a later pass. `firstPass` is false for the follow-up passes of one maintenance
 * episode. `reserved` counts D1 queries the caller runs in the same invocation. */
export async function runScheduledMaintenance(env: Env, { firstPass = true, reserved = 0 }: { firstPass?: boolean; reserved?: number } = {}): Promise<MaintenanceResult> {
	const { db, count } = countD1Queries(env.DB, { queries: reserved, statements: reserved });
	if (await db.prepare(`SELECT 1 FROM maintenance_state WHERE key='${DEPLOYMENT_FENCE_KEY}'`).first()) return { removedObjects: 0, backlog: false };
	const encryption = await readEncryptionState(db);
	if (encryption?.mode === 'resetting') return { removedObjects: 0, backlog: false };
	// Descriptors exist only in an active encrypted vault; each release rechecks that.
	const encrypted = encryption?.mode === 'active';
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
				['prune shared checkpoints', bounded(() => pruneSharedCheckpoints(env.BUCKET, db))],
		// Changelog entries and deletion receipts usually expire before the versions of
		// their revisions, so each descriptor is released with its last reference.
		['prune changelog', bounded(() => pruneChangelog(db, encrypted ? expired => releasePrunedChangelogDescriptors(db, expired) : undefined))],
		['prune file deletion receipts', bounded(() => pruneFileDeletionReceipts(db))],
		['prune Reading removals', bounded(() => pruneReadingRemovals(db))],
		['expire file versions', bounded(() => enqueueExpiredFileVersions(db, Date.now(),
			encrypted ? expired => releaseExpiredVersionDescriptors(db, expired) : undefined))],
		['drain object cleanup', async () => { removedObjects = await drainObjectCleanupQueue(env.BUCKET, db); }],
		['prune obsolete reminder occurrences', () => pruneReminderOccurrences(db)],
		['prune expired operation receipts', bounded(() => pruneOperationReceipts(db))],
		['prune request limits', () => db.prepare('DELETE FROM request_rate_limits WHERE expires_at < ?').bind(Date.now() - 60_000).run()],
		['prune tokens', () => pruneExpiredTokens(db)],
		['clean unfinished uploads', async () => { removedObjects += await cleanStagedUploads(env.BUCKET, db); }],
		['clean unfinished upload batches', async () => { removedObjects += await cleanStagedBatches(env.BUCKET, db); }],
	];
	if (encrypted) tasks.push(['prune unused encryption metadata', bounded(() => pruneEncryptionMetadata(db, firstPass))]);
	// Three queries plus the run record's batch; on a pass whose earlier work leaves
	// too few, this waits for the next one.
	tasks.push(['prune expired encrypted response chunks', async () => {
		if (count.queries + 4 > D1_QUERIES_PER_INVOCATION) backlog = true;
		else await pruneEncryptedReceiptChunks(db);
	}]);
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
