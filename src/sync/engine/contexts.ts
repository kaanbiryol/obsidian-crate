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
import type { PendingKey } from '../pending/pending-change';
import { createFullSyncPlan } from '../planner/full';
import { runIncrementalSync } from '../planner/incremental';
import { getLocalChanges as planLocalChanges, getLocalDeletes as planLocalDeletes } from '../planner/local';
import { prepareUploadFromPath as prepareTransferUploadFromPath, prepareUploadFromVaultFile } from '../transfer/prepare';
import { parallelDownloadAndSaveFiles as transferParallelDownloadAndSaveFiles } from '../transfer/download';
import { processDiff as transferProcessDiff } from '../transfer/process';
import { moveUnchangedLocalFile } from '../local/local-move';
import { uploadPreparedFiles as transferUploadPreparedFiles } from '../transfer/upload';
import { PREPARE_CONCURRENCY, DOWNLOAD_CONCURRENCY } from '../transfer/constants';
import type { SyncResult, SyncState, SyncWork } from '../types';
import type { FileDiff } from '../planner/types';
import type { PreparedUpload } from '../transfer/types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import { assertNoOpenInitialImport, runInitialImport } from './initial-import';
import { finishInitialSetup } from './initial-setup';
import type { InitialConfigPull } from '../manifest/initial-config-pull';
import { MAX_DEBOUNCE_WAIT_MS, updateSyncProgress, type SyncSettings } from '../settings';
import type { ReconnectNotice, WorkflowCompletionContext } from '../sync-outcome';
import { runSyncWorkflow, type SyncWorkflowContext } from './standard-sync-workflow';
import { reconcileServerIdentity } from './server-identity';
import type { ForceSyncWorkflowContext } from './force-sync-workflow';
import { reconcileQueuePaths } from './reconcile-paths';
import { uploadFullSyncPlan } from './full-sync-upload';
import { createPathRecord } from '../../protocol/path-record';
import { replaceVaultBeforeFirstSync } from '../local/vault-replacement';
import { mergeSyncResults } from '../sync-result';
import { createAbortError } from '../abort';
import type { SyncQueueControllerContext } from '../queue/controller';

const VAULT_REPLACEMENT_UNFINISHED = 'Select Sync now to finish replacing this vault with your Crate server’s contents.';

interface SyncEngineContextDependencies {
	prepareReminderScope?: () => Promise<void>;
	/** Lets local writers finish before a first upload lists vault files. */
	prepareInitialUpload?: () => Promise<void>;
	vault: Vault;
	pluginDir: string;
	fileManager: FileManager;
	api: SyncApiClient;
	files: EngineFileOperations;
	localManifest: LocalManifest;
	markdownBaseCache: MarkdownBaseCache;
	conflictStore: ConflictStore;
	getSettings: () => SyncSettings;
	/** Saves the settings `getSettings` returns, as the runtime does after each sync. */
	persistSettings: () => Promise<void>;
	pendingFullSyncRequest: () => { complete(): void } | null;
	getStatus: () => SyncState['status'];
	shouldIgnore: (path: string) => boolean;
	runConcurrent: <T>(tasks: (() => Promise<T>)[], concurrency: number) => Promise<T[]>;
	retryWithBackoff: <T>(fn: () => Promise<T>) => Promise<T>;
	getModifiedIso: (path: string, fallbackMtime?: number) => Promise<string>;
	getPendingKeys: () => string[];
	verifyContent: (files: VaultFile[]) => Promise<boolean>;
	updateState: (updates: Partial<SyncState>) => void;
	reconnectNotice: ReconnectNotice;
	signal: AbortSignal;
	/** Prepares reminder settings again, logging rather than throwing a failure. */
	retryReminderScope: () => Promise<void>;
	verifyPendingPaths: (keys: string[], isCurrent: (key: string) => boolean, replayed?: ReadonlySet<string>) => Promise<string[]>;
	/** Reconciles queue keys that lost a compare-and-swap race and publishes the outcome. */
	reconcileQueue: (queueKeys: string[]) => Promise<SyncResult>;
	onFlushResult: (result: SyncResult) => void | Promise<void>;
}

/** Contexts are built once: every member reads engine state when called. The
 * incremental and full planners are the exception, since they snapshot settings
 * when a sync starts. */
export class SyncEngineContexts {
	private readonly plannedContent = new PlannedContent();
	/** Paths the running sync leaves alone in both directions, at the user's request.
	 * Empty outside `runStandardSync`. */
	private held: ReadonlySet<string> = new Set();
	private readonly isHeld = (path: string): boolean => this.held.has(path);
	/** Planners skip held paths as they skip ignored ones; other ignore checks, such as the
	 * pending queue's, never see them, so their pending changes stay. */
	private readonly skipPath = (path: string): boolean => this.isHeld(path) || this.dependencies.shouldIgnore(path);
	private readonly transfer: TransferContext;
	private readonly localDiffPlanner: LocalDiffPlannerContext;
	/** Publishes a finished sync's outcome. */
	readonly completion: WorkflowCompletionContext;
	readonly syncWorkflow: SyncWorkflowContext;
	readonly forceSyncWorkflow: ForceSyncWorkflowContext;
	readonly queue: SyncQueueControllerContext;

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
			maxFileBytes: this.maxFileBytes,
		};
		this.localDiffPlanner = {
			signal: d.signal,
			vault: d.vault,
			plannedContent: this.plannedContent,
			localManifest: d.localManifest,
			shouldIgnore: this.skipPath,
			verifyContent: d.verifyContent,
			runConcurrent: d.runConcurrent,
			encrypted: this.encrypted,
			maxFileBytes: this.maxFileBytes,
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
			signal: d.signal,
			localManifest: d.localManifest,
			deleteRemoteFiles: this.deleteRemoteFiles,
			getManifest: () => d.api.getManifest(),
			uploadPreparedFiles: this.uploadPreparedFiles,
		};
		this.syncWorkflow = {
			...base,
			replaceLocalVault: this.replaceLocalVault,
			reconcileServerIdentity: () => reconcileServerIdentity({ settings: d.getSettings(), localManifest: d.localManifest,
				checkForChanges: since => d.api.checkForChanges(since), setLastSeq: this.setLastSeq, persistSettings: d.persistSettings }),
			tryInitialImport: (result, progress) => runInitialImport({ transfer: this.transfer, api: d.api,
				prepareReminderScope: d.prepareReminderScope,
				beforeUpload: async () => {
					this.markUploadOnly();
					await d.prepareInitialUpload?.();
				},
				shouldIgnore: d.shouldIgnore, signal: d.signal,
				save: () => d.localManifest.save(),
				setLastSeq: this.setLastSeq,
				report: this.reportWork,
				getImportToken: () => d.localManifest.getInitialImportToken(),
				setImportToken: token => d.localManifest.setInitialImportToken(token),
				heldPaths: this.held,
			}, result, progress),
			// Resolved per call so tests can replace the incremental planner.
			incrementalSync: (progressCallback, onFailure) => this.incrementalSync(progressCallback, onFailure),
			pendingFullSyncRequest: d.pendingFullSyncRequest,
			hasSyncCursor: () => d.getSettings().lastSeq > 0,
			createFullSyncPlan: (remoteFiles, concurrency, options) => createFullSyncPlan({
				...this.localDiffPlanner,
				isHeld: this.isHeld,
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
			reconcileVersionConflicts: this.reconcileVersionConflicts,
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles,
			setLastSeq: this.setLastSeq,
			maxFileBytes: this.maxFileBytes,
		};
		this.forceSyncWorkflow = {
			...base,
			vault: d.vault,
			shouldIgnore: d.shouldIgnore,
			prepareForceUpload: (file, expectedHash) => prepareUploadFromVaultFile(this.transfer, file, { force: true, expectedHash }),
			encrypted: this.encrypted,
			maxFileBytes: this.maxFileBytes,
		};
		this.queue = {
			finishInitialSetup: this.finishInitialSetup,
			uploadPreparedFiles: this.uploadPreparedFiles,
			maxFileBytes: this.maxFileBytes,
			deleteRemoteFiles: this.deleteRemoteFiles,
			automaticSyncEnabled: () => d.getSettings().automaticSync,
			recoverUploads: async () => {
				void d.retryReminderScope();
				await this.beforeTargetedTransfer({ recover: true });
				this.reportWork({ phase: 'applying' });
			},
			apiConfigured: base.apiConfigured,
			localManifest: d.localManifest,
			shouldIgnore: d.shouldIgnore,
			...this.completion,
			signal: d.signal,
			getStatus: d.getStatus,
			verifyPendingPaths: d.verifyPendingPaths,
			prepareUploadFromPath: this.prepareUploadFromPath,
			getDebounceDelayMs: () => (d.getSettings().debounceDelay ?? 5) * 1000,
			maxDebounceWaitMs: MAX_DEBOUNCE_WAIT_MS,
			reconcile: d.reconcileQueue,
			onFlushResult: d.onFlushResult,
		};
	}

	/** Runs a standard sync that leaves `held` paths alone. Planned content and held paths
	 * last only for this run. */
	async runStandardSync(held: ReadonlySet<string>, progress?: (current: number, total: number) => void): Promise<SyncResult> {
		this.plannedContent.clear();
		this.held = held;
		try { return await runSyncWorkflow(this.syncWorkflow, progress); }
		finally {
			this.held = new Set();
			this.plannedContent.clear();
		}
	}

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
					reconcileVersionConflicts: async keys => { retryPaths.push(...keys); },
					localManifest: d.localManifest,
					signal: d.signal,
					maxFileBytes: this.maxFileBytes,
				}, diffs, createPathRecord<FileEntry>(), result, () => {});
				for (const failure of failures) onFailure?.(failure);
				return retryPaths;
			},
			processDiff: this.processDiff,
			onFailure,
			maxFileBytes: this.maxFileBytes,
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

	/** The rest of the running sync only reads vault files. */
	private readonly markUploadOnly = (): void => this.dependencies.updateState({ writesVault: false });

	private readonly encrypted = (): boolean => this.dependencies.api.isEncrypted();

	/** Read from the server info each sync refreshes before it plans anything. */
	readonly maxFileBytes = (): number => this.dependencies.api.fileLimit();

	/** Replays interrupted uploads before any path is planned, reporting recovery progress.
	 * Every upload path recovers first, so none runs before a confirmed replacement. */
	readonly recoverUploads = (): Promise<void> => {
		this.assertNoVaultReplacement();
		return this.replayUploads();
	};

	/** Reconciles queued paths after the checks every targeted transfer runs first. */
	readonly reconcilePaths = async (queueKeys: PendingKey[], recover = true, onFailure?: (failure: MutationFailure) => void): Promise<SyncResult> => {
		await this.beforeTargetedTransfer({ recover });
		this.dependencies.signal.throwIfAborted();
		return this.reconcileQueuePaths(queueKeys, onFailure);
	};

	/** Folds a reconciliation of paths that lost a version race into the running sync's result. */
	private readonly reconcileVersionConflicts = async (keys: PendingKey[], result: SyncResult): Promise<void> => {
		const reconciliation = await this.reconcilePaths(keys);
		mergeSyncResults(result, reconciliation);
		if (reconciliation.outcome === 'cancelled') throw createAbortError('Sync reconciliation aborted');
	};

	/** Runs before a queue flush or a targeted reconciliation transfers anything. The local
	 * replacement check comes first, so no server request runs before it passes. */
	readonly beforeTargetedTransfer = async ({ recover }: { recover: boolean }): Promise<void> => {
		this.assertNoVaultReplacement();
		await assertNoOpenInitialImport(this.dependencies.api, this.dependencies.localManifest);
		if (recover) await this.replayUploads();
	};

	private async replayUploads(): Promise<void> {
		await this.dependencies.api.refreshFileLimit();
		return this.dependencies.files.recoverUploads((current, total) => this.dependencies.updateState({ work: { phase: 'recovering', current, total } }));
	}

	private assertNoVaultReplacement(): void {
		if (this.dependencies.getSettings().replaceVault) throw new Error(VAULT_REPLACEMENT_UNFINISHED);
	}

	/** Runs before anything else in a standard sync. */
	readonly replaceLocalVault = (): Promise<void> => {
		const d = this.dependencies;
		return replaceVaultBeforeFirstSync({
			settings: d.getSettings(), manifest: d.localManifest, vault: d.vault, pluginDir: d.pluginDir,
			reportWork: this.reportWork, saveSettings: d.persistSettings, signal: d.signal,
		});
	};

	readonly finishInitialSetup = (): Promise<void> => {
		const d = this.dependencies;
		return finishInitialSetup({
			manifest: d.localManifest, lastSeq: d.getSettings().lastSeq,
			initialImport: d.api.initialImport, prepareReminderScope: d.prepareReminderScope,
			reportWork: this.reportWork, markUploadOnly: this.markUploadOnly, signal: d.signal,
		});
	};

	/** The planner reads the settings object current when the sync starts. */
	async incrementalSync(progressCallback?: (current: number, total: number) => void, onFailure?: (failure: MutationFailure) => void): Promise<SyncResult | null> {
		const d = this.dependencies;
		return runIncrementalSync({
			settings: d.getSettings(),
			setLastSeq: this.setLastSeq,
			persistSettings: d.persistSettings,
			reportWork: this.reportWork,
			signal: d.signal,
			vault: d.vault,
			fileManager: d.fileManager,
			files: d.files,
			localManifest: d.localManifest,
			shouldIgnore: this.skipPath,
			maxFileBytes: this.maxFileBytes,
			getLocalChanges: onUnchanged => planLocalChanges({
				...this.localDiffPlanner,
				pendingKeys: new Set(d.getPendingKeys()),
			}, PREPARE_CONCURRENCY, onUnchanged),
			getLocalDeletes: discoveredPaths => planLocalDeletes(this.localDiffPlanner, discoveredPaths, PREPARE_CONCURRENCY),
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles,
			moveUnchangedLocalFile: (from, to, hash, revision) => moveUnchangedLocalFile(this.transfer, from, to, hash, revision),
			processDiff: this.processDiff,
			prepareUploadFromPath: this.prepareUploadFromPath,
			uploadPreparedFiles: this.uploadPreparedFiles,
			reconcileVersionConflicts: this.reconcileVersionConflicts,
			awaitingReviewPaths: () => d.conflictStore.awaitingReviewPaths(path => d.localManifest.getEntry(path)?.revision),
			getRemoteEntries: async paths => (await d.api.getFileMetadata(paths)).files,
		}, {
			progressCallback,
			onFailure,
		});
	}
}
