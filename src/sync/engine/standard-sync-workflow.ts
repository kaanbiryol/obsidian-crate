import type { DeleteRemoteFiles } from '../transfer/delete';
import { createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import type { FullSyncUploadContext } from './full-sync-upload';
import { createLogger } from '../logger';
import type { FileDiff, RemoteManifest, SyncResult } from '../types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import type { DownloadRequest } from '../transfer/download';
import type { DiffApplyOutcome } from '../transfer/types';
import type { FullSyncPlan } from '../planner/types';
import type { LocalManifest } from '../manifest/manifest';
import {
	beginSyncAttempt,
	completeTransferResult,
	completeWorkflowResult,
	handleWorkflowError,
	type SyncStatus,
	type WorkflowCompletionContext,
} from '../sync-outcome';
import { runFullSync } from './full-sync-workflow';

const logger = createLogger('SyncEngine');

export interface SyncWorkflowContext extends FullSyncUploadContext, WorkflowCompletionContext {
	deleteRemoteFiles: DeleteRemoteFiles;
	finishInitialSetup(): Promise<void>;
	/** Moves the vault to trash when the user chose to replace it with the joined server's contents. */
	replaceLocalVault?(): Promise<void>;
	tryInitialImport(result: SyncResult, progress?: (current: number, total: number) => void): Promise<SyncResult | null>;
	apiConfigured(): boolean;
	recoverUploads(): Promise<void>;
	getStatus(): SyncStatus;
	getManifest(): Promise<RemoteManifest>;
	incrementalSync(
		progressCallback?: (current: number, total: number) => void,
		onFailure?: (failure: MutationFailure) => void,
	): Promise<SyncResult | null>;
	throwIfDestroyed(): void;
	createFullSyncPlan(
		remoteFiles: Record<string, FileEntry> | Promise<Record<string, FileEntry>>,
		concurrency: number,
		options?: { reuseUnchangedHashes?: boolean },
	): Promise<FullSyncPlan>;
	/** True when this device has synced before and holds a changelog cursor. */
	hasSyncCursor(): boolean;
	/** A request to skip the changelog once and compare the whole server inventory. */
	fullSyncRequest?(): { complete(): void } | null;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<DiffApplyOutcome>;
	/** Publishes the downloading phase itself. */
	parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void, onFailure?: (failure: MutationFailure) => void): Promise<void>;
	localManifest: Pick<LocalManifest, 'getEntry' | 'setEntry' | 'save'>;
	setLastSeq(value: number): void;
}

export async function runSyncWorkflow(
	context: SyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = beginSyncAttempt(context);
	if (startFailure) return startFailure;
	logger.info('Sync started');
	let result = createEmptySyncResult();
	let recovering = false;
	let fullSyncRequest: { complete(): void } | null = null;

	try {
		await context.replaceLocalVault?.();
		context.updateState({ work: { phase: 'recovering' } });
		await context.recoverUploads();
		const imported = await context.tryInitialImport(result, progressCallback);
		if (imported) {
			result = imported;
			if (finalizeSyncResult(imported)) await context.finishInitialSetup();
			completeWorkflowResult(context, imported, { errorFallback: 'Initial sync completed with errors' });
			return imported;
		}
		context.updateState({ work: { phase: 'server' } });
		context.throwIfDestroyed();
		recovering = context.hasSyncCursor();
		fullSyncRequest = context.fullSyncRequest?.() ?? null;
		const incrementalFailures: MutationFailure[] = [];
		const incrementalResult = fullSyncRequest ? null
			: await context.incrementalSync(progressCallback, failure => { incrementalFailures.push(failure); });
		if (incrementalResult) {
			result = incrementalResult;
			if (finalizeSyncResult(result)) await context.finishInitialSetup();
			completeTransferResult(context, incrementalResult, incrementalFailures, {
				errorFallback: 'Incremental sync completed with errors',
				failureLogPrefix: 'Incremental sync failed',
				logger,
			});
			return incrementalResult;
		}
	} catch (error) {
		handleWorkflowError(context, result, error, { abortLogMessage: 'Sync recovery aborted', failureLogPrefix: 'Sync recovery failed', logger });
		finalizeSyncResult(result);
		return result;
	}

	logger.info('Running full sync');
	await runFullSync(context, result, recovering, progressCallback);
	if (finalizeSyncResult(result)) fullSyncRequest?.complete();
	return result;
}
