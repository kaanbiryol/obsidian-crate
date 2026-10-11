import type { DeleteRemoteFiles } from './transfer-delete';
import type { Vault } from 'obsidian';
import { recordSyncError } from './issues';
import { getAllVaultFiles, type VaultFile } from './file-discovery';
import {
	createEmptySyncResult,
	finalizeSyncResult,
} from './sync-result';
import { createLogger, errorMessage } from '../plugin/logger';
import type { LocalManifestView } from './manifest';
import { getPathEntry } from '../protocol/path-record';
import type { PreparedUpload, SyncResult, SyncState } from './types';
import {
	completeWorkflowResult,
	getStartFailureResult,
	handleWorkflowError,
	type RemoteManifest,
	type SyncStatus,
} from './engine-workflow-shared';

const logger = createLogger('SyncEngine');

export interface ForceSyncWorkflowContext {
	finishInitialSetup(): Promise<void>;
	vault: Vault;
	apiConfigured(): boolean;
	recoverUploads(): Promise<void>;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	shouldIgnore(path: string): boolean;
	isAbortError(error: unknown): boolean;
	getManifest(): Promise<RemoteManifest>;
	snapshotLocalManifest(): LocalManifestView;
	clearLocalManifest(): void;
	replaceLocalManifest(manifest: LocalManifestView): void;
	createVaultFileChunks(files: VaultFile[]): VaultFile[][];
	prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void
	): Promise<PreparedUpload[]>;
	uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: import('./transfer-upload').UploadPreparedFilesOptions
	): Promise<void>;
	throwIfDestroyed(): void;
	deleteRemoteFiles: DeleteRemoteFiles;
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
	let previousLocalManifest = context.snapshotLocalManifest();
	let manifestCommitted = false;
	let manifestCleared = false;

	try {
		context.updateState({ work: { phase: 'recovering' } });
		await context.recoverUploads();
		previousLocalManifest = context.snapshotLocalManifest();
		context.throwIfDestroyed();
		context.updateState({ work: { phase: 'server' } });
		const remoteManifest = await context.getManifest();
		const remotePaths = new Set(Object.keys(remoteManifest.files));

		context.updateState({ work: { phase: 'scanning' } });
		const files = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path), () => context.throwIfDestroyed());
		const localPaths = new Set(files.map(file => file.path));

		const remoteOnlyPaths = [...remotePaths].filter(
			path => !localPaths.has(path) && !context.shouldIgnore(path),
		);

		let uploadsProcessed = 0;
		const total = files.length + remoteOnlyPaths.length;
		let current = 0;

		context.clearLocalManifest();
		manifestCleared = true;

		for (const chunk of context.createVaultFileChunks(files)) {
			context.updateState({ work: { phase: 'preparing' } });
			const prepared = await context.prepareUploadsFromVaultFiles(chunk, () => {
				current++;
				progressCallback?.(current, total);
			});
			for (const upload of prepared) {
				upload.expectedHash = getPathEntry(remoteManifest.files, upload.path)?.hash ?? null;
			}

			context.throwIfDestroyed();
			context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: files.length } });
			await context.uploadPreparedFiles(prepared, result, {
				onProcessed: count => {
					uploadsProcessed += count;
					context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: files.length } });
				},
				retry: true,
			});
			if (result.errors.length > 0) {
				throw new Error('Force full sync stopped before deleting remote files because an upload failed');
			}
		}

		context.throwIfDestroyed();

		await context.deleteRemoteFiles(remoteOnlyPaths.flatMap(path => {
			const entry = getPathEntry(remoteManifest.files, path);
			if (!entry?.hash) { recordSyncError(result, 'Missing remote version for delete', path); return []; }
			return [{ path, expectedHash: entry.hash, expectedRevision: entry.revision }];
		}), result, { onProcessed: count => { current += count; progressCallback?.(current, total); } });

		context.updateState({ work: { phase: 'saving' } });
		await context.saveLocalManifest();
		manifestCommitted = result.errors.length === 0;

		logger.info(
			`Force full sync completed: ${result.uploaded} uploaded, ${result.deleted} remote-only deleted`,
		);
		if (!result.errors.length) await context.finishInitialSetup();
		completeWorkflowResult(context, result, {
			errorFallback: 'Force full sync completed with errors',
		});
	} catch (error) {
			handleWorkflowError(context, result, error, {
			abortLogMessage: 'Force full sync aborted',
			failureLogPrefix: 'Force full sync failed',
			logger,
			logGenericError: true,
		});
	} finally {
		if (manifestCleared && !manifestCommitted) {
			context.replaceLocalManifest(previousLocalManifest);
			try {
				context.updateState({ work: { phase: 'saving' } });
		await context.saveLocalManifest();
			} catch (error) {
				result.errors.push(`restore local manifest: ${errorMessage(error)}`);
			}
		}
	}

	finalizeSyncResult(result);
	return result;
}
