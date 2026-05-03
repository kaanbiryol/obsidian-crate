import { Notice, type Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import {
	createEmptySyncResult,
	finalizeSyncResult,
	getSyncResultError,
} from './sync-result';
import {
	AUTH_ERROR_MESSAGE,
	BATCH_UPLOAD_CONCURRENCY,
	INITIAL_SYNC_PIPELINE_CHUNK_FILES,
	UPLOAD_CONCURRENCY,
	isAuthError,
} from './engine-constants';
import { createLogger, errorMessage } from '../plugin/logger';
import type { PreparedUpload, SyncResult, SyncState } from '../plugin/types';
import { getStartFailureResult, type SyncStatus } from './engine-workflow-shared';

const logger = createLogger('SyncEngine');

export interface InitialSyncWorkflowContext {
	vault: Vault;
	apiConfigured(): boolean;
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
		options: { concurrency: number; retry: boolean; batchConcurrency?: number }
	): Promise<void>;
	createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][];
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
		const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path));
		logger.info(`Initial sync started with ${files.length} files`);
		const total = files.length;
		let preparedCount = 0;
		let uploadCandidates = 0;

		const chunks = context.createVaultFileChunks(files, INITIAL_SYNC_PIPELINE_CHUNK_FILES);
		const prepareChunk = (chunk: VaultFile[]) => context.prepareUploadsFromVaultFiles(chunk, () => {
			preparedCount++;
			progressCallback?.(preparedCount, total);
		});

		let chunkIndex = 0;
		const firstChunk = chunks[0];
		let currentPrepare = firstChunk ? prepareChunk(firstChunk) : null;
		while (currentPrepare) {
			const preparedChunk = await currentPrepare;
			context.throwIfDestroyed();
			uploadCandidates += preparedChunk.length;

			chunkIndex++;
			const nextChunk = chunks[chunkIndex];
			const nextPrepare = nextChunk ? prepareChunk(nextChunk) : null;

			if (preparedChunk.length > 0) {
				await context.uploadPreparedFiles(preparedChunk, result, {
					concurrency: UPLOAD_CONCURRENCY,
					retry: true,
					batchConcurrency: BATCH_UPLOAD_CONCURRENCY,
				});
			}

			currentPrepare = nextPrepare;
		}

		logger.info(
			`Prepared ${uploadCandidates}/${total} files for upload (${total - uploadCandidates} unchanged)`,
		);
		await context.saveLocalManifest();

		logger.info(`Initial sync completed: ${result.uploaded} uploaded`);
		if (finalizeSyncResult(result)) {
			const lastSync = new Date().toISOString();
			context.updateState({
				status: 'idle',
				lastSync,
				lastError: null,
			});
			context.setLastSync(lastSync);
		} else {
			context.updateState({
				status: 'error',
				lastError: getSyncResultError(result, 'Initial sync completed with errors'),
			});
		}
	} catch (error) {
		if (context.isAbortError(error)) {
			logger.info('Initial sync aborted');
		} else if (isAuthError(error)) {
			result.errors.push(AUTH_ERROR_MESSAGE);
			logger.error('Initial sync failed: auth error (401)');
			new Notice(AUTH_ERROR_MESSAGE);
			context.updateState({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		} else {
			const errMsg = errorMessage(error);
			result.errors.push(errMsg);
			context.updateState({ status: 'error', lastError: errMsg });
		}
	}

	finalizeSyncResult(result);
	return result;
}
