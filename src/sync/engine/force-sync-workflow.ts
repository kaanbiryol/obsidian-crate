import { createDeleteCandidates, type DeleteRemoteFiles } from '../transfer/delete';
import type { Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from '../local/file-discovery';
import { partitionSkippedUploads } from '../local/local-file-changes';
import { unsupportedLocalPathIssue } from '../local/local-path-safety';
import { oversizedRemoteFileIssue, rejectedSealedNoteIssue } from '../issues';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import {
	createEmptySyncResult,
	finalizeSyncResult,
} from '../sync-result';
import { createLogger } from '../logger';
import { getPathEntry } from '../../protocol/path-record';
import { namespaceConflictLookup } from '../namespace-conflicts';
import type { PreparedUpload, RemoteManifest, SyncResult } from '../types';
import type { LocalManifest } from '../manifest/manifest';
import type { MutationFailure } from '../../protocol/sync-types';
import {
	beginSyncAttempt,
	completeTransferResult,
	handleWorkflowError,
	type SyncStatus,
	type WorkflowCompletionContext,
} from '../sync-outcome';

const logger = createLogger('SyncEngine');

export interface ForceSyncWorkflowContext extends WorkflowCompletionContext {
	finishInitialSetup(): Promise<void>;
	vault: Vault;
	apiConfigured(): boolean;
	recoverUploads(): Promise<void>;
	getStatus(): SyncStatus;
	shouldIgnore(path: string): boolean;
	getManifest(): Promise<RemoteManifest>;
	localManifest: Pick<LocalManifest, 'getAllPaths' | 'removeEntry' | 'save'>;
	createVaultFileChunks(files: VaultFile[]): VaultFile[][];
	/** Whether uploads are encrypted, which limits how deep a synced file can be. */
	encrypted(): boolean;
	prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void
	): Promise<PreparedUpload[]>;
	uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: import('../transfer/upload').UploadPreparedFilesOptions
	): Promise<void>;
	throwIfDestroyed(): void;
	deleteRemoteFiles: DeleteRemoteFiles;
}

export async function runForceFullSyncWorkflow(
	context: ForceSyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = beginSyncAttempt(context);
	if (startFailure) return startFailure;
	const result = createEmptySyncResult();
	const failures: MutationFailure[] = [];

	try {
		context.updateState({ work: { phase: 'recovering' } });
		await context.recoverUploads();
		context.throwIfDestroyed();
		context.updateState({ work: { phase: 'server' } });
		const remoteManifest = await context.getManifest();
		const remotePaths = new Set(Object.keys(remoteManifest.files));

		context.updateState({ work: { phase: 'scanning' } });
		const localFiles = await getAllVaultFiles(context.vault, path => context.shouldIgnore(path), () => context.throwIfDestroyed());
		// Skipped files stay local paths, so their server copy is neither replaced nor deleted.
		const localPaths = new Set(localFiles.map(file => file.path));
		const { eligible: files, skipped } = partitionSkippedUploads(localFiles, context.encrypted());
		if (skipped.length) (result.issues ??= []).push(...skipped);

		// A remote file this device cannot hold is absent here because it was skipped, not
		// deleted: a rejected sealed note, one over the size limit, or a name this device
		// cannot store. It stays on the server and stays reported.
		const remoteOnlyPaths: string[] = [];
		for (const path of remotePaths) {
			if (localPaths.has(path) || context.shouldIgnore(path)) continue;
			const entry = getPathEntry(remoteManifest.files, path);
			const kept = entry?.rejected ? rejectedSealedNoteIssue(path)
				: entry && entry.size > MAX_FILE_SIZE_BYTES ? oversizedRemoteFileIssue(path)
					: unsupportedLocalPathIssue(path);
			if (kept) (result.issues ??= []).push(kept);
			else remoteOnlyPaths.push(path);
		}

		let uploadsProcessed = 0;
		const total = files.length + remoteOnlyPaths.length;
		let current = 0;
		const deleteRemoteOnly = async (paths: string[]) => {
			failures.push(...await context.deleteRemoteFiles(createDeleteCandidates(paths.map(path => {
				const entry = getPathEntry(remoteManifest.files, path);
				return { path, hash: entry?.hash, revision: entry?.revision };
			}), result), result, { onProcessed: count => { current += count; progressCallback?.(current, total); } }));
		};
		// The server cannot store a remote-only path beside a local file in its
		// namespace, as after a case-only or Unicode-only rename, so it goes first.
		const localConflict = namespaceConflictLookup(files.map(file => file.path));
		await deleteRemoteOnly(remoteOnlyPaths.filter(path => localConflict(path) !== undefined));

		// The manifest keeps its baselines while uploading, so an interrupted run
		// leaves correct entries for every file it has not reached yet.
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
				onFailure: failure => { failures.push(failure); },
				retry: true,
			});
			if (result.errors.length > 0) {
				throw new Error('Force full sync stopped before deleting remote files because an upload failed');
			}
		}

		context.throwIfDestroyed();

		await deleteRemoteOnly(remoteOnlyPaths.filter(path => localConflict(path) === undefined));

		if (!result.errors.length) {
			for (const path of context.localManifest.getAllPaths()) {
				if (!localPaths.has(path)) context.localManifest.removeEntry(path);
			}
		}
		context.updateState({ work: { phase: 'saving' } });
		await context.localManifest.save();

		logger.info(
			`Force full sync completed: ${result.uploaded} uploaded, ${result.deleted} remote-only deleted`,
		);
		if (!result.errors.length) await context.finishInitialSetup();
		completeTransferResult(context, result, failures, {
			errorFallback: 'Force full sync completed with errors',
			failureLogPrefix: 'Force full sync failed',
			logger,
		});
	} catch (error) {
			handleWorkflowError(context, result, error, {
			abortLogMessage: 'Force full sync aborted',
			failureLogPrefix: 'Force full sync failed',
			logger,
			logGenericError: true,
			failures,
		});
	}

	finalizeSyncResult(result);
	return result;
}
