import { createDeleteCandidates, type DeleteRemoteFiles } from '../transfer/delete';
import type { Vault } from 'obsidian';
import { getAllVaultFiles, type VaultFile } from '../local/file-discovery';
import { skippedUploadIssue } from '../local/local-file-changes';
import { rejectedSealedNoteIssue } from '../issues';
import {
	createEmptySyncResult,
	finalizeSyncResult,
} from '../sync-result';
import { createLogger } from '../logger';
import { getPathEntry } from '../../protocol/path-record';
import { namespaceConflictLookup } from '../namespace-conflicts';
import type { PreparedUpload, RemoteManifest, SyncResult, SyncState } from '../types';
import type { MutationFailure } from '../../protocol/sync-types';
import {
	beginSyncAttempt,
	completeTransferResult,
	handleWorkflowError,
	type ReconnectNotice,
	type SyncStatus,
} from '../sync-outcome';

const logger = createLogger('SyncEngine');

export interface ForceSyncWorkflowContext {
	finishInitialSetup(): Promise<void>;
	vault: Vault;
	apiConfigured(): boolean;
	recoverUploads(): Promise<void>;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	shouldIgnore(path: string): boolean;
	getManifest(): Promise<RemoteManifest>;
	getLocalManifestPaths(): string[];
	removeLocalManifestEntry(path: string): void;
	createVaultFileChunks(files: VaultFile[]): VaultFile[][];
	/** Whether uploads are encrypted, which limits how deep a synced file can be. */
	encrypted?(): boolean;
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
	saveLocalManifest(): Promise<void>;
	setLastSync(value: string): void;
	reconnectNotice: ReconnectNotice;
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
		const skipped = localFiles.flatMap(file => skippedUploadIssue(file, context.encrypted?.() ?? false) ?? []);
		const skippedPaths = new Set(skipped.map(issue => issue.path));
		const files = localFiles.filter(file => !skippedPaths.has(file.path));
		if (skipped.length) (result.issues ??= []).push(...skipped);

		// A rejected sealed note has no local name to delete it by, so it stays reported.
		const rejected = [...remotePaths].filter(path => !localPaths.has(path) && getPathEntry(remoteManifest.files, path)?.rejected);
		if (rejected.length) (result.issues ??= []).push(...rejected.map(rejectedSealedNoteIssue));
		const remoteOnlyPaths = [...remotePaths].filter(
			path => !localPaths.has(path) && !context.shouldIgnore(path) && !getPathEntry(remoteManifest.files, path)?.rejected,
		);

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
			for (const path of context.getLocalManifestPaths()) {
				if (!localPaths.has(path)) context.removeLocalManifestEntry(path);
			}
		}
		context.updateState({ work: { phase: 'saving' } });
		await context.saveLocalManifest();

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
