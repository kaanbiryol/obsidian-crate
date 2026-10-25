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
import { prepareUploadFromPath as prepareTransferUploadFromPath } from '../transfer/prepare';
import { parallelDownloadAndSaveFiles as transferParallelDownloadAndSaveFiles } from '../transfer/download';
import { processDiff as transferProcessDiff } from '../transfer/process';
import {
	prepareUploadsFromVaultFiles as transferPrepareUploadsFromVaultFiles,
	uploadPreparedFiles as transferUploadPreparedFiles,
} from '../transfer/upload';
import { createByteBudgetedVaultFileChunks } from '../transfer/budget';
import { PREPARE_CONCURRENCY, DOWNLOAD_CONCURRENCY } from '../transfer/constants';
import type { FileDiff, PreparedUpload, SyncResult, SyncState, SyncWork } from '../types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import { runInitialImport } from './initial-import';
import { finishInitialSetup } from './initial-setup';
import type { InitialConfigPull } from '../manifest/initial-config-pull';
import { updateSyncProgress, type SyncSettings } from '../settings';
import type { ReconnectNotice } from '../sync-outcome';
import type { SyncWorkflowContext } from './standard-sync-workflow';
import type { ForceSyncWorkflowContext } from './force-sync-workflow';

interface SyncEngineContextDependencies {
	prepareReminderScope?: () => Promise<void>;
	vault: Vault;
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
		};
		this.localDiffPlanner = {
			throwIfDestroyed: d.throwIfDestroyed,
			vault: d.vault,
			plannedContent: this.plannedContent,
			localManifest: d.localManifest,
			shouldIgnore: d.shouldIgnore,
			verifyContent: d.verifyContent,
			runConcurrent: d.runConcurrent,
		};
		// Members shared by the standard, initial and forced sync workflows.
		const base = {
			finishInitialSetup: this.finishInitialSetup,
			apiConfigured: () => d.api.isConfigured(),
			reportWork: this.reportWork,
			recoverUploads: this.recoverUploads,
			getStatus: d.getStatus,
			updateState: d.updateState,
			throwIfDestroyed: d.throwIfDestroyed,
			saveLocalManifest: () => d.localManifest.save(),
			setLastSync: this.setLastSync,
			reconnectNotice: d.reconnectNotice,
			deleteRemoteFiles: this.deleteRemoteFiles,
			getManifest: () => d.api.getManifest(),
			uploadPreparedFiles: this.uploadPreparedFiles,
		};
		this.syncWorkflow = {
			...base,
			tryInitialImport: (result, progress) => runInitialImport({ transfer: this.transfer, api: d.api,
				prepareReminderScope: d.prepareReminderScope,
				shouldIgnore: d.shouldIgnore, throwIfDestroyed: d.throwIfDestroyed,
				save: () => d.localManifest.save(),
				setLastSeq: lastSeq => updateSyncProgress(d.getSettings(), { lastSeq }),
				report: work => d.updateState({ work }),
				getImportToken: () => d.localManifest.getInitialImportToken(),
				setImportToken: token => d.localManifest.setInitialImportToken(token),
			}, result, progress),
			// Resolved per call so tests can replace the incremental planner.
			incrementalSync: (progressCallback, onFailure) => this.incrementalSync(progressCallback, onFailure),
			hasSyncCursor: () => d.getSettings().lastSeq > 0,
			createFullSyncPlan: (remoteFiles, concurrency, options) => createFullSyncPlan({
				initialConfigPull: {
					firstSync: d.getSettings().lastSync === null && d.getSettings().lastSeq === 0,
					get: () => d.localManifest.getInitialConfigPull(),
					save: async (state: InitialConfigPull) => {
						d.localManifest.setInitialConfigPull(state);
						await d.localManifest.save();
					},
				},
				throwIfDestroyed: d.throwIfDestroyed,
				vault: d.vault,
				plannedContent: this.plannedContent,
				localManifest: d.localManifest,
				shouldIgnore: d.shouldIgnore,
				runConcurrent: d.runConcurrent,
			}, remoteFiles, concurrency, options),
			processDiff: this.processDiff,
			prepareFullSyncUpload: diff => prepareTransferUploadFromPath(this.transfer, diff.path, { force: true, expectedHash: diff.remoteHash ?? null }),
			reconcileVersionConflicts: d.reconcileVersionConflicts,
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles,
			getLocalManifestEntry: path => d.localManifest.getEntry(path),
			setLocalManifestEntry: (path, entry) => {
				d.localManifest.setEntry(path, entry);
			},
			setLastSeq: value => {
				updateSyncProgress(d.getSettings(), { lastSeq: value });
			},
		};
		this.forceSyncWorkflow = {
			...base,
			vault: d.vault,
			shouldIgnore: d.shouldIgnore,
			getLocalManifestPaths: () => d.localManifest.getAllPaths(),
			removeLocalManifestEntry: path => d.localManifest.removeEntry(path),
			prepareUploadsFromVaultFiles: (files, onPrepared) =>
				transferPrepareUploadsFromVaultFiles(this.transfer, files, PREPARE_CONCURRENCY, onPrepared, { force: true }),
			createVaultFileChunks: createByteBudgetedVaultFileChunks,
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
		reportWork: work => this.dependencies.updateState({ work }),
	}, files, result, options);

	readonly processDiff = (diff: FileDiff, localFiles: Record<string, FileEntry>, result: SyncResult): Promise<DiffApplyOutcome> =>
		transferProcessDiff(this.transfer, diff, localFiles, result);

	private readonly parallelDownloadAndSaveFiles = (requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void, onFailure?: (failure: MutationFailure) => void): Promise<void> =>
		transferParallelDownloadAndSaveFiles(this.transfer, requests, result, DOWNLOAD_CONCURRENCY, onProcessed, onFailure);

	readonly setLastSync = (value: string): void => updateSyncProgress(this.dependencies.getSettings(), { lastSync: value });

	/** Replays interrupted uploads before any path is planned, reporting recovery progress. */
	readonly recoverUploads = (): Promise<void> =>
		this.dependencies.files.recoverUploads((current, total) => this.dependencies.updateState({ work: { phase: 'recovering', current, total } }));

	readonly finishInitialSetup = (): Promise<void> => {
		const d = this.dependencies;
		return finishInitialSetup({
			manifest: d.localManifest, lastSeq: d.getSettings().lastSeq,
			initialImport: d.api.initialImport, prepareReminderScope: d.prepareReminderScope,
			reportWork: work => d.updateState({ work }), assertActive: d.throwIfDestroyed,
		});
	};

	private readonly reportWork = (phase: SyncWork['phase'], current?: number, total?: number): void =>
		this.dependencies.updateState({ work: { phase, current, total } });

	/** The planner reads the settings object current when the sync starts. */
	async incrementalSync(progressCallback?: (current: number, total: number) => void, onFailure?: (failure: MutationFailure) => void): Promise<SyncResult | null> {
		const d = this.dependencies;
		return runIncrementalSync({
			settings: d.getSettings(),
			setLastSeq: (lastSeq: number) => updateSyncProgress(d.getSettings(), { lastSeq }),
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
		}, {
			progressCallback,
			onFailure,
		});
	}
}
