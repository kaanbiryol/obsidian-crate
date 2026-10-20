import { deleteRemoteFiles, type DeleteRemoteFiles } from '../transfer/delete';
import type { EngineFileOperations } from './file-operations';
import { PlannedContent } from '../planner/planned-content';
import type { FileManager, Vault } from 'obsidian';
import type { SyncApiClient } from '../api';
import type { LocalManifest, LocalManifestView } from '../manifest/manifest';
import type { MarkdownBaseCache } from '../merge/markdown-base-cache';
import type { ConflictStore } from '../conflict/store';
import type { DownloadRequest } from '../transfer/download';
import type { DiffApplyOutcome } from '../transfer/types';
import type { VaultFile } from '../local/file-discovery';
import type { UploadPreparedFilesOptions } from '../transfer/upload';
import type { LocalChangeScan } from '../planner/types';
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
import { PREPARE_CONCURRENCY, DOWNLOAD_CONCURRENCY } from './constants';
import type { FileDiff, UploadDiff, PreparedUpload, SyncResult, SyncState, SyncWork } from '../types';
import type { FileEntry } from '../../protocol/sync-types';
import { runInitialImport } from './initial-import';
import { finishInitialSetup } from './initial-setup';
import type { InitialConfigPull } from './initial-config-pull';
import { updateSyncProgress, type SyncSettings } from '../settings';

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
	getPendingPaths: () => string[];
	verifyContent: (files: VaultFile[]) => Promise<boolean>;
	reconcileVersionConflicts: (paths: string[], result: SyncResult) => Promise<void>;
	updateState: (updates: Partial<SyncState>) => void;
	throwIfDestroyed: () => void;
}

export class SyncEngineContexts {
	private readonly plannedContent = new PlannedContent();
	clearPlannedContent(): void { this.plannedContent.clear(); }
	constructor(private dependencies: SyncEngineContextDependencies) {}

	async prepareUploadFromPath(path: string): Promise<PreparedUpload | null> {
		return prepareTransferUploadFromPath(this.transfer(), path);
	}

	private async getLocalDeletes(discoveredPaths: ReadonlySet<string>): Promise<string[]> {
		return planLocalDeletes(this.localDiffPlanner(), discoveredPaths, PREPARE_CONCURRENCY);
	}

	async incrementalSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult | null> {
		return runIncrementalSync(this.incrementalPlanner(), {
			progressCallback,
		});
	}

	private async getLocalChanges(onUnchanged?: (path: string) => void): Promise<LocalChangeScan> {
		return planLocalChanges({
			...this.localDiffPlanner(),
			pendingPaths: new Set(this.dependencies.getPendingPaths()),
		}, PREPARE_CONCURRENCY, onUnchanged);
	}

	private async parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void): Promise<void> {
		await transferParallelDownloadAndSaveFiles(
			this.transfer(),
			requests,
			result,
			DOWNLOAD_CONCURRENCY,
			onProcessed,
		);
	}

	async processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<DiffApplyOutcome> {
		return transferProcessDiff(this.transfer(), diff, localFiles, result);
	}

	async prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void,
	): Promise<PreparedUpload[]> {
		return transferPrepareUploadsFromVaultFiles(
			this.transfer(),
			files,
			PREPARE_CONCURRENCY,
			onPrepared,
		);
	}

	async uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: UploadPreparedFilesOptions,
	): Promise<void> {
		await transferUploadPreparedFiles(this.transfer(), prepared, result, options);
	}

	setLastSync = (value: string): void => updateSyncProgress(this.dependencies.getSettings(), { lastSync: value });

	deleteRemoteFiles: DeleteRemoteFiles = (files, result, options) => deleteRemoteFiles({
		api: this.dependencies.files,
		vault: this.dependencies.vault,
		localManifest: this.dependencies.localManifest,
		reportWork: work => this.dependencies.updateState({ work }),
	}, files, result, options);

	private transfer() {
		const dependencies = this.dependencies;
		return {
			vault: dependencies.vault,
			plannedContent: this.plannedContent,
			fileManager: dependencies.fileManager,
			api: dependencies.files,
			localManifest: dependencies.localManifest,
			markdownBaseCache: dependencies.markdownBaseCache,
			conflictStore: dependencies.conflictStore,
			runConcurrent: dependencies.runConcurrent,
			retryWithBackoff: dependencies.retryWithBackoff,
			getModifiedIso: dependencies.getModifiedIso,
		};
	}

	private localDiffPlanner() {
		const dependencies = this.dependencies;
		return {
			throwIfDestroyed: dependencies.throwIfDestroyed,
			vault: dependencies.vault,
			plannedContent: this.plannedContent,
			localManifest: dependencies.localManifest,
			shouldIgnore: dependencies.shouldIgnore,
			verifyContent: dependencies.verifyContent,
			runConcurrent: dependencies.runConcurrent,
		};
	}

	private incrementalPlanner() {
		const dependencies = this.dependencies;
		return {
			settings: dependencies.getSettings(),
			setLastSeq: (lastSeq: number) => updateSyncProgress(dependencies.getSettings(), { lastSeq }),
			reportWork: (phase: SyncWork['phase'], current?: number, total?: number) => dependencies.updateState({ work: { phase, current, total } }),
			throwIfDestroyed: dependencies.throwIfDestroyed,
			vault: dependencies.vault,
			fileManager: dependencies.fileManager,
			api: dependencies.files,
			localManifest: dependencies.localManifest,
			shouldIgnore: dependencies.shouldIgnore,
			getLocalChanges: this.getLocalChanges.bind(this),
			getLocalDeletes: this.getLocalDeletes.bind(this),
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles.bind(this),
			processDiff: this.processDiff.bind(this),
			prepareUploadFromPath: this.prepareUploadFromPath.bind(this),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			reconcileVersionConflicts: dependencies.reconcileVersionConflicts,
		};
	}

	private fullSyncPlanner() {
		const dependencies = this.dependencies;
		return {
			initialConfigPull: {
				firstSync: dependencies.getSettings().lastSync === null && dependencies.getSettings().lastSeq === 0,
				get: () => dependencies.localManifest.getInitialConfigPull(),
				save: async (state: InitialConfigPull) => {
					const manifest = dependencies.localManifest;
					manifest.setInitialConfigPull(state);
					await manifest.save();
				},
			},
			throwIfDestroyed: dependencies.throwIfDestroyed,
			vault: dependencies.vault,
			plannedContent: this.plannedContent,
			localManifest: dependencies.localManifest,
			shouldIgnore: dependencies.shouldIgnore,
			runConcurrent: dependencies.runConcurrent,
		};
	}

	/** Members shared by the standard, initial and forced sync workflows. */
	private workflowBase() {
		const dependencies = this.dependencies;
		return {
			finishInitialSetup: () => this.finishInitialSetup(),
			apiConfigured: () => dependencies.api.isConfigured(),
			reportWork: (phase: SyncWork['phase'], current?: number, total?: number) => dependencies.updateState({ work: { phase, current, total } }),
			recoverUploads: () => dependencies.files.recoverUploads((current, total) => dependencies.updateState({ work: { phase: 'recovering', current, total } })),
			getStatus: dependencies.getStatus,
			updateState: dependencies.updateState,
			throwIfDestroyed: dependencies.throwIfDestroyed,
			saveLocalManifest: () => dependencies.localManifest.save(),
			setLastSync: this.setLastSync,
		};
	}

	syncWorkflow() {
		const dependencies = this.dependencies;
		return {
			...this.workflowBase(),
			tryInitialImport: (result: SyncResult, progress?: (current: number, total: number) => void) => this.tryInitialImport(result, progress),
			deleteRemoteFiles: this.deleteRemoteFiles,
			getManifest: () => dependencies.api.getManifest(),
			incrementalSync: this.incrementalSync.bind(this),
			hasSyncCursor: () => dependencies.getSettings().lastSeq > 0,
			createFullSyncPlan: (remoteFiles: Record<string, FileEntry>, concurrency: number, options?: { reuseUnchangedHashes?: boolean }) =>
				createFullSyncPlan(this.fullSyncPlanner(), remoteFiles, concurrency, options),
			processDiff: this.processDiff.bind(this),
			prepareFullSyncUpload: (diff: UploadDiff) => prepareTransferUploadFromPath(this.transfer(), diff.path, { force: true, expectedHash: diff.remoteHash ?? null }),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			reconcileVersionConflicts: dependencies.reconcileVersionConflicts,
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles.bind(this),
			getLocalManifestEntry: (path: string) => dependencies.localManifest.getEntry(path),
			setLocalManifestEntry: (path: string, entry: FileEntry) => {
				dependencies.localManifest.setEntry(path, entry);
			},
			setLastSeq: (value: number) => {
				updateSyncProgress(dependencies.getSettings(), { lastSeq: value });
			},
		};
	}

	initialSyncWorkflow() {
		const dependencies = this.dependencies;
		return {
			...this.workflowBase(),
			tryInitialImport: (result: SyncResult, progress?: (current: number, total: number) => void) => this.tryInitialImport(result, progress),
			vault: dependencies.vault,
			shouldIgnore: dependencies.shouldIgnore,
			prepareUploadsFromVaultFiles: this.prepareUploadsFromVaultFiles.bind(this),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			createVaultFileChunks: createByteBudgetedVaultFileChunks,
		};
	}

	finishInitialSetup(): Promise<void> {
		const dependencies = this.dependencies;
		return finishInitialSetup({
			manifest: dependencies.localManifest, lastSeq: dependencies.getSettings().lastSeq,
			initialImport: dependencies.api.initialImport, prepareReminderScope: dependencies.prepareReminderScope,
			reportWork: work => dependencies.updateState({ work }), assertActive: dependencies.throwIfDestroyed,
		});
	}

	private tryInitialImport(result: SyncResult, progress?: (current: number, total: number) => void) {
		const dependencies = this.dependencies;
		return runInitialImport({ transfer: this.transfer(), api: dependencies.api,
			prepareReminderScope: dependencies.prepareReminderScope,
			shouldIgnore: dependencies.shouldIgnore, throwIfDestroyed: dependencies.throwIfDestroyed,
			save: () => dependencies.localManifest.save(),
			setLastSeq: lastSeq => updateSyncProgress(dependencies.getSettings(), { lastSeq }),
			report: work => dependencies.updateState({ work }),
		}, result, progress);
	}

	forceSyncWorkflow() {
		const dependencies = this.dependencies;
		return {
			...this.workflowBase(),
			vault: dependencies.vault,
			deleteRemoteFiles: this.deleteRemoteFiles,
			shouldIgnore: dependencies.shouldIgnore,
			getManifest: () => dependencies.api.getManifest(),
			snapshotLocalManifest: () => structuredClone(dependencies.localManifest.getManifest()),
			clearLocalManifest: () => dependencies.localManifest.clear(),
			replaceLocalManifest: (manifest: LocalManifestView) => dependencies.localManifest.replaceManifest(manifest),
			prepareUploadsFromVaultFiles: this.prepareUploadsFromVaultFiles.bind(this),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			createVaultFileChunks: createByteBudgetedVaultFileChunks,
		};
	}
}
