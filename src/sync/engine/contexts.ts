import { deleteRemoteFiles, type DeleteRemoteFiles } from '../transfer/delete';
import type { EngineFileOperations } from './file-operations';
import { PlannedContent } from '../planner/planned-content';
import type { FileManager, Vault } from 'obsidian';
import type { SyncApiClient } from '../worker-api/client';
import type { LocalManifest } from '../manifest/manifest';
import type { MarkdownBaseCache } from '../merge/markdown-base-cache';
import type { ConflictStore } from '../conflict/store';
import type { DownloadRequest } from '../transfer/download';
import type { DiffApplyOutcome, TransferContext } from '../transfer/types';
import type { VaultFile } from '../local/file-discovery';
import type { UploadPreparedFilesOptions } from '../transfer/upload';
import type { LocalDiffPlannerContext } from '../planner/types';
import { createFullSyncPlan } from '../planner/full';
import { runIncrementalSync } from '../planner/incremental';
import { getLocalChanges as planLocalChanges, getLocalDeletes as planLocalDeletes } from '../planner/local';
import { prepareUploadFromPath as prepareTransferUploadFromPath, prepareUploadFromVaultFile } from '../transfer/prepare';
import { parallelDownloadAndSaveFiles as transferParallelDownloadAndSaveFiles } from '../transfer/download';
import { processDiff as transferProcessDiff } from '../transfer/process';
import { uploadPreparedFiles as transferUploadPreparedFiles } from '../transfer/upload';
import { PREPARE_CONCURRENCY, DOWNLOAD_CONCURRENCY } from '../transfer/constants';
import type { FileDiff, PreparedUpload, SyncResult, SyncState, SyncWork } from '../types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import { runInitialImport } from './initial-import';
import { finishInitialSetup } from './initial-setup';
import type { InitialConfigPull } from '../manifest/initial-config-pull';
import { updateSyncProgress, type SyncSettings } from '../settings';
import type { ReconnectNotice, WorkflowCompletionContext } from '../sync-outcome';
import type { SyncWorkflowContext } from './standard-sync-workflow';
import type { ForceSyncWorkflowContext } from './force-sync-workflow';
import { reconcileQueuePaths } from './reconcile-paths';
import { uploadFullSyncPlan } from './full-sync-upload';
import { createPathRecord } from '../../protocol/path-record';
import { moveVaultToTrash } from '../local/vault-replacement';

const VAULT_REPLACEMENT_UNFINISHED = 'Select Sync now to finish replacing this vault with your Crate server’s contents.';

interface SyncEngineContextDependencies {
	prepareReminderScope?: () => Promise<void>;
	vault: Vault;
	pluginDir: string;
	fileManager: FileManager;
	api: SyncApiClient;
	files: EngineFileOperations;
	localManifest: LocalManifest;
	markdownBaseCache: MarkdownBaseCache;
	conflictStore: ConflictStore;
	getSettings: () => SyncSettings;
	getStatus: () => SyncState['status'];
	shouldIgnore: (path: string) => boolean;
	runConcurrent: <T>(tasks: (() => Promise<T>)[], concurrency: number) => Promise<T[]>;
	retryWithBackoff: <T>(fn: () => Promise<T>) => Promise<T>;
	getModifiedIso: (path: string, fallbackMtime?: number) => Promise<string>;
	getPendingKeys: () => string[];
	verifyContent: (files: VaultFile[]) => Promise<boolean>;
	reconcileVersionConflicts: (paths: string[], result: SyncResult) => Promise<void>;
	updateState: (updates: Partial<SyncState>) => void;
	reconnectNotice: ReconnectNotice;
	throwIfDestroyed: () => void;
}

/** Contexts are built once: every member reads engine state when called. The
 * incremental and full planners are the exception, since they snapshot settings
 * when a sync starts. */
export class SyncEngineContexts {
	private readonly plannedContent = new PlannedContent();
	private readonly transfer: TransferContext;
	private readonly localDiffPlanner: LocalDiffPlannerContext;
	/** Publishes a finished sync's outcome. */
	readonly completion: WorkflowCompletionContext;
	readonly syncWorkflow: SyncWorkflowContext;
	readonly forceSyncWorkflow: ForceSyncWorkflowContext;

	constructor(private readonly dependencies: SyncEngineContextDependencies) {
		const d = dependencies;
		this.transfer = {
			vault: d.vault,
			plannedContent: this.plannedContent,
			fileManager: d.fileManager,
			files: d.files,
			localManifest: d.localManifest,
			markdownBaseCache: d.markdownBaseCache,
			conflictStore: d.conflictStore,
			runConcurrent: d.runConcurrent,
			retryWithBackoff: d.retryWithBackoff,
			getModifiedIso: d.getModifiedIso,
			encrypted: this.encrypted,
		};
		this.localDiffPlanner = {
			throwIfDestroyed: d.throwIfDestroyed,
			vault: d.vault,
			plannedContent: this.plannedContent,
			localManifest: d.localManifest,
			shouldIgnore: d.shouldIgnore,
			verifyContent: d.verifyContent,
			runConcurrent: d.runConcurrent,
			encrypted: this.encrypted,
		};
		this.completion = { updateState: d.updateState, setLastSync: this.setLastSync, reconnectNotice: d.reconnectNotice };
		// Members shared by the standard, initial and forced sync workflows.
		const base = {
			finishInitialSetup: this.finishInitialSetup,
			apiConfigured: () => d.api.isConfigured(),
			reportWork: this.reportWork,
			recoverUploads: this.recoverUploads,
			getStatus: d.getStatus,
			...this.completion,
			throwIfDestroyed: d.throwIfDestroyed,
			localManifest: d.localManifest,
			deleteRemoteFiles: this.deleteRemoteFiles,
			getManifest: () => d.api.getManifest(),
			uploadPreparedFiles: this.uploadPreparedFiles,
		};
		this.syncWorkflow = {
			...base,
			replaceLocalVault: this.replaceLocalVault,
			tryInitialImport: (result, progress) => runInitialImport({ transfer: this.transfer, api: d.api,
				prepareReminderScope: d.prepareReminderScope,
				shouldIgnore: d.shouldIgnore, throwIfDestroyed: d.throwIfDestroyed,
				save: () => d.localManifest.save(),
				setLastSeq: this.setLastSeq,
				report: this.reportWork,
				getImportToken: () => d.localManifest.getInitialImportToken(),
				setImportToken: token => d.localManifest.setInitialImportToken(token),
			}, result, progress),
			// Resolved per call so tests can replace the incremental planner.
			incrementalSync: (progressCallback, onFailure) => this.incrementalSync(progressCallback, onFailure),
			hasSyncCursor: () => d.getSettings().lastSeq > 0,
			createFullSyncPlan: (remoteFiles, concurrency, options) => createFullSyncPlan({
				...this.localDiffPlanner,
				initialConfigPull: {
					firstSync: d.getSettings().lastSync === null && d.getSettings().lastSeq === 0,
					get: () => d.localManifest.getInitialConfigPull(),
					save: async (state: InitialConfigPull) => {
						d.localManifest.setInitialConfigPull(state);
						await d.localManifest.save();
					},
				},
			}, remoteFiles, concurrency, options),
			processDiff: this.processDiff,
			prepareFullSyncUpload: diff => prepareTransferUploadFromPath(this.transfer, diff.path, { force: true, expectedHash: diff.remoteHash ?? null }),
			reconcileVersionConflicts: d.reconcileVersionConflicts,
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles,
			setLastSeq: this.setLastSeq,
		};
		this.forceSyncWorkflow = {
			...base,
			vault: d.vault,
			shouldIgnore: d.shouldIgnore,
			prepareForceUpload: (file, expectedHash) => prepareUploadFromVaultFile(this.transfer, file, { force: true, expectedHash }),
			encrypted: this.encrypted,
		};
	}

	clearPlannedContent(): void { this.plannedContent.clear(); }

	readonly prepareUploadFromPath = (path: string): Promise<PreparedUpload | null> =>
		prepareTransferUploadFromPath(this.transfer, path);

	readonly uploadPreparedFiles = (prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void> =>
		transferUploadPreparedFiles(this.transfer, prepared, result, options);

	/** Prepares a synced file even when unchanged, conditioned on its acknowledged hash. */
	readonly prepareRepublish = (path: string): Promise<PreparedUpload | null> => {
		const hash = this.dependencies.localManifest.getEntry(path)?.hash;
		return hash ? prepareTransferUploadFromPath(this.transfer, path, { force: true, expectedHash: hash }) : Promise.resolve(null);
	};

	readonly deleteRemoteFiles: DeleteRemoteFiles = (files, result, options) => deleteRemoteFiles({
		files: this.dependencies.files,
		vault: this.dependencies.vault,
		localManifest: this.dependencies.localManifest,
		reportWork: this.reportWork,
	}, files, result, options);

	/** Reconciles queued paths with the server. Version conflicts return their paths for another pass. */
	readonly reconcileQueuePaths = (queueKeys: string[], onFailure?: (failure: MutationFailure) => void): Promise<SyncResult> => {
		const d = this.dependencies;
		return reconcileQueuePaths({
			reportWork: this.reportWork,
			vault: d.vault,
			localManifest: d.localManifest,
			getRemoteEntries: async (paths) => (await d.api.getFileMetadata(paths)).files,
			deleteRemoteFiles: this.deleteRemoteFiles,
			shouldIgnore: d.shouldIgnore,
			uploadDiffs: async (diffs, result) => {
				const retryPaths: string[] = [];
				const failures = await uploadFullSyncPlan({
					reportWork: this.reportWork,
					prepareFullSyncUpload: diff => this.syncWorkflow.prepareFullSyncUpload(diff),
					uploadPreparedFiles: this.uploadPreparedFiles,
					// Conflicted paths return to the queue pass for a fresh reconciliation.
					reconcileVersionConflicts: async paths => { retryPaths.push(...paths); },
					localManifest: d.localManifest,
					throwIfDestroyed: d.throwIfDestroyed,
				}, diffs, createPathRecord<FileEntry>(), result, () => {});
				for (const failure of failures) onFailure?.(failure);
				return retryPaths;
			},
			processDiff: this.processDiff,
			onFailure,
		}, queueKeys);
	};

	readonly processDiff = (diff: FileDiff, localFiles: Record<string, FileEntry>, result: SyncResult): Promise<DiffApplyOutcome> =>
		transferProcessDiff(this.transfer, diff, localFiles, result);

	/** Publishes the downloading phase before the first file and as each one finishes. */
	private readonly parallelDownloadAndSaveFiles = (requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void, onFailure?: (failure: MutationFailure) => void): Promise<void> => {
		let processed = 0;
		this.reportWork({ phase: 'downloading', current: processed, total: requests.length });
		return transferParallelDownloadAndSaveFiles(this.transfer, requests, result, DOWNLOAD_CONCURRENCY, () => {
			processed++;
			this.reportWork({ phase: 'downloading', current: processed, total: requests.length });
			onProcessed?.();
		}, onFailure);
	};

	readonly setLastSync = (value: string): void => updateSyncProgress(this.dependencies.getSettings(), { lastSync: value });

	private readonly setLastSeq = (value: number): void => updateSyncProgress(this.dependencies.getSettings(), { lastSeq: value });

	private readonly reportWork = (work: SyncWork): void => this.dependencies.updateState({ work });

	private readonly encrypted = (): boolean => this.dependencies.api.isEncrypted();

	/** Replays interrupted uploads before any path is planned, reporting recovery progress.
	 * Every upload path recovers first, so none runs before a confirmed replacement. */
	readonly recoverUploads = (): Promise<void> => {
		this.assertNoVaultReplacement();
		return this.dependencies.files.recoverUploads((current, total) => this.dependencies.updateState({ work: { phase: 'recovering', current, total } }));
	};

	assertNoVaultReplacement(): void {
		if (this.dependencies.getSettings().replaceVault) throw new Error(VAULT_REPLACEMENT_UNFINISHED);
	}

	/** Runs before anything else in a standard sync. The runtime saves the cleared flag with the sync's progress. */
	readonly replaceLocalVault = async (): Promise<void> => {
		const d = this.dependencies;
		const settings = d.getSettings();
		if (!settings.replaceVault) return;
		// Once a file has synced, moving the vault again would trash the server's copies.
		if (settings.lastSeq === 0 && !Object.keys(d.localManifest.getManifest().files).length) {
			d.updateState({ work: { phase: 'applying' } });
			await moveVaultToTrash(d.vault, d.pluginDir, d.throwIfDestroyed);
		}
		settings.replaceVault = false;
	};

	readonly finishInitialSetup = (): Promise<void> => {
		const d = this.dependencies;
		return finishInitialSetup({
			manifest: d.localManifest, lastSeq: d.getSettings().lastSeq,
			initialImport: d.api.initialImport, prepareReminderScope: d.prepareReminderScope,
			reportWork: this.reportWork, throwIfDestroyed: d.throwIfDestroyed,
		});
	};

	/** The planner reads the settings object current when the sync starts. */
	async incrementalSync(progressCallback?: (current: number, total: number) => void, onFailure?: (failure: MutationFailure) => void): Promise<SyncResult | null> {
		const d = this.dependencies;
		return runIncrementalSync({
			settings: d.getSettings(),
			setLastSeq: this.setLastSeq,
			reportWork: this.reportWork,
			throwIfDestroyed: d.throwIfDestroyed,
			vault: d.vault,
			fileManager: d.fileManager,
			files: d.files,
			localManifest: d.localManifest,
			shouldIgnore: d.shouldIgnore,
			getLocalChanges: onUnchanged => planLocalChanges({
				...this.localDiffPlanner,
				pendingKeys: new Set(d.getPendingKeys()),
			}, PREPARE_CONCURRENCY, onUnchanged),
			getLocalDeletes: discoveredPaths => planLocalDeletes(this.localDiffPlanner, discoveredPaths, PREPARE_CONCURRENCY),
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles,
			processDiff: this.processDiff,
			prepareUploadFromPath: this.prepareUploadFromPath,
			uploadPreparedFiles: this.uploadPreparedFiles,
			reconcileVersionConflicts: d.reconcileVersionConflicts,
			// Removing the saved copy outside the review records the baseline revision;
			// until a choice or sync moves it, the incoming version is saved again.
			awaitingReviewPaths: () => d.conflictStore.getIncomingReviews()
				.filter(conflict => conflict.status === 'active' || conflict.reviewBaseRevision !== undefined
					&& d.localManifest.getEntry(conflict.originalPath)?.revision === conflict.reviewBaseRevision)
				.map(conflict => conflict.originalPath),
			getRemoteEntries: async paths => (await d.api.getFileMetadata(paths)).files,
		}, {
			progressCallback,
			onFailure,
		});
	}
}
