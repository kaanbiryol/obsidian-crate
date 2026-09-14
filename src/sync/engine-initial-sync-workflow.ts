import type { Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import {
	createEmptySyncResult,
	finalizeSyncResult,
} from './sync-result';
import {
	BATCH_UPLOAD_CONCURRENCY,
	UPLOAD_CONCURRENCY,
} from './engine-constants';
import { createLogger } from '../plugin/logger';
import type { PreparedUpload, SyncResult, SyncState } from './types';
import {
	completeWorkflowResult,
	getStartFailureResult,
	handleWorkflowError,
	type SyncStatus,
} from './engine-workflow-shared';

const logger = createLogger('SyncEngine');

export interface InitialSyncWorkflowContext {
  finishInitialSetup?(): Promise<void>;
  tryInitialImport?(result: SyncResult, progress?: (current: number, total: number) => void): Promise<SyncResult | null>;
	vault: Vault;
	apiConfigured(): boolean;
	recoverUploads(): Promise<void>;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	shouldIgnore(path: string): boolean;
	isAbortError(error: unknown): boolean;
	prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void
	): Promise<PreparedUpload[]>;
	uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean; batchConcurrency?: number; onProcessed?: (count: number) => void }
	): Promise<void>;
	createVaultFileChunks(files: VaultFile[]): VaultFile[][];
	saveLocalManifest(): Promise<void>;
	throwIfDestroyed(): void;
	setLastSync(value: string): void;
}

export async function runInitialSyncWorkflow(
	context: InitialSyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = getStartFailureResult(context);
	if (startFailure) return startFailure;

	context.updateState({ status: 'syncing' });
	const result = createEmptySyncResult();

	try {
		context.updateState({ work: { phase: 'recovering' } });
		await context.recoverUploads();
		context.throwIfDestroyed();
    const imported = await context.tryInitialImport?.(result, progressCallback);
    if (imported) {
      if (!imported.errors.length) await context.finishInitialSetup?.();
      completeWorkflowResult(context, imported, { errorFallback: 'Initial sync completed with errors' });
      return imported;
    }
		context.updateState({ work: { phase: 'scanning' } });
		const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path));
		logger.info(`Initial sync started with ${files.length} files`);
		let uploadsProcessed = 0;
		const total = files.length;
		let preparedCount = 0;
		let uploadCandidates = 0;

		const chunks = context.createVaultFileChunks(files);
		const prepareChunk = (chunk: VaultFile[]) => context.prepareUploadsFromVaultFiles(chunk, () => {
			preparedCount++;
			context.updateState({ work: { phase: 'preparing', current: preparedCount, total } });
			progressCallback?.(preparedCount, total);
		});

		for (const chunk of chunks) {
			context.updateState({ work: { phase: 'preparing', current: preparedCount, total } });
			const preparedChunk = await prepareChunk(chunk);
			context.throwIfDestroyed();
			uploadCandidates += preparedChunk.length;
			uploadsProcessed += chunk.length - preparedChunk.length;

			if (preparedChunk.length > 0) {
				context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: files.length } });
			await context.uploadPreparedFiles(preparedChunk, result, {
					onProcessed: count => {
						uploadsProcessed += count;
						context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: files.length } });
					},
					concurrency: UPLOAD_CONCURRENCY,
					retry: true,
					batchConcurrency: BATCH_UPLOAD_CONCURRENCY,
				});
			}
		}

		logger.info(
			`Prepared ${uploadCandidates}/${total} files for upload (${total - uploadCandidates} unchanged)`,
		);
		context.updateState({ work: { phase: 'saving' } });
		await context.saveLocalManifest();

		logger.info(`Initial sync completed: ${result.uploaded} uploaded`);
		if (!result.errors.length) await context.finishInitialSetup?.();
		completeWorkflowResult(context, result, {
			errorFallback: 'Initial sync completed with errors',
		});
	} catch (error) {
		handleWorkflowError(context, result, error, {
			abortLogMessage: 'Initial sync aborted',
			failureLogPrefix: 'Initial sync failed',
			logger,
		});
	}

	finalizeSyncResult(result);
	return result;
}
