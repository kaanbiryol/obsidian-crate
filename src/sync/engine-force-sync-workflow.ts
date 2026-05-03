import { Notice, type Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import {
	createEmptySyncResult,
	finalizeSyncResult,
	getSyncResultError,
} from './sync-result';
import {
	AUTH_ERROR_MESSAGE,
	FORCE_SYNC_CONCURRENCY,
	isAuthError,
} from './engine-constants';
import { createLogger, errorMessage } from '../plugin/logger';
import type { PreparedUpload, SyncResult, SyncState } from '../plugin/types';
import {
	getStartFailureResult,
	type RemoteManifest,
	type SyncStatus,
} from './engine-workflow-shared';

const logger = createLogger('SyncEngine');

export interface ForceSyncWorkflowContext {
	vault: Vault;
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	shouldIgnore(path: string): boolean;
	isAbortError(error: unknown): boolean;
	getManifest(): Promise<RemoteManifest>;
	clearLocalManifest(): void;
	prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void
	): Promise<PreparedUpload[]>;
	uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean; batchConcurrency?: number }
	): Promise<void>;
	throwIfDestroyed(): void;
	deleteRemoteFile(path: string): Promise<void>;
	removeLocalManifestEntry(path: string): void;
	saveLocalManifest(): Promise<void>;
	setLastSync(value: string): void;
}

export async function runForceFullSyncWorkflow(
	context: ForceSyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = getStartFailureResult(context);
	if (startFailure) return startFailure;

	context.updateState({ status: 'syncing' });
	const result = createEmptySyncResult();

	try {
		const remoteManifest = await context.getManifest();
		const remotePaths = new Set(Object.keys(remoteManifest.files));

		const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path));
		const localPaths = new Set(files.map(file => file.path));

		const remoteOnlyPaths = [...remotePaths].filter(
			path => !localPaths.has(path) && !context.shouldIgnore(path),
		);

		const total = files.length + remoteOnlyPaths.length;
		let current = 0;

		context.clearLocalManifest();

		const prepared = await context.prepareUploadsFromVaultFiles(files, completed => {
			current = completed;
			progressCallback?.(current, total);
		});

		context.throwIfDestroyed();

		await context.uploadPreparedFiles(prepared, result, {
			concurrency: FORCE_SYNC_CONCURRENCY,
			retry: true,
		});

		context.throwIfDestroyed();

		for (const path of remoteOnlyPaths) {
			try {
				await context.deleteRemoteFile(path);
				context.removeLocalManifestEntry(path);
				result.deleted++;
				result.deletedPaths.push(path);
			} catch (error) {
				result.errors.push(`delete ${path}: ${errorMessage(error)}`);
			}
			current++;
			progressCallback?.(current, total);
		}

		await context.saveLocalManifest();

		const lastSync = new Date().toISOString();
		logger.info(
			`Force full sync completed: ${result.uploaded} uploaded, ${result.deleted} remote-only deleted`,
		);
		if (finalizeSyncResult(result)) {
			context.updateState({
				status: 'idle',
				lastSync,
				lastError: null,
			});
			context.setLastSync(lastSync);
		} else {
			context.updateState({
				status: 'error',
				lastError: getSyncResultError(result, 'Force full sync completed with errors'),
			});
		}
	} catch (error) {
		if (context.isAbortError(error)) {
			logger.info('Force full sync aborted');
		} else if (isAuthError(error)) {
			result.errors.push(AUTH_ERROR_MESSAGE);
			logger.error('Force full sync failed: auth error (401)');
			new Notice(AUTH_ERROR_MESSAGE);
			context.updateState({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
		} else {
			const errMsg = errorMessage(error);
			result.errors.push(errMsg);
			logger.error('Force full sync failed:', errMsg);
			context.updateState({ status: 'error', lastError: errMsg });
		}
	}

	finalizeSyncResult(result);
	return result;
}
