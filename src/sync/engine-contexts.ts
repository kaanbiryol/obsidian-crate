import type { EngineFileOperations } from './engine-file-operations';
import { PlannedContent } from './planned-content';
import type { FileManager, Vault } from 'obsidian';
import type { SyncApiClient } from './api';
import type { LocalManifest } from './manifest';
import type { MarkdownBaseCache } from './markdown-base-cache';
import type { ConflictStore } from './conflict-store';
import type { DownloadRequest } from './transfer-download';
import type { DiffApplyOutcome } from './transfer-types';
import type { VaultFile } from './file-discovery';
import type { UploadPreparedFilesOptions } from './transfer-upload';
import {
	createFullSyncPlan,
	getLocalChanges as planLocalChanges,
	getLocalDeletes as planLocalDeletes,
	runIncrementalSync,
} from './planner';
import {
	prepareUploadFromPath as prepareTransferUploadFromPath,
	parallelDownloadAndSaveFiles as transferParallelDownloadAndSaveFiles,
	processDiff as transferProcessDiff,
	prepareUploadsFromVaultFiles as transferPrepareUploadsFromVaultFiles,
	uploadPreparedFiles as transferUploadPreparedFiles,
} from './transfer';
import { createByteBudgetedVaultFileChunks } from './transfer-budget';
import { PREPARE_CONCURRENCY, UPLOAD_CONCURRENCY, DOWNLOAD_CONCURRENCY } from './engine-constants';
import type { CrateSettings } from '../plugin/settings-types';
import type { FileDiff, UploadDiff, PreparedUpload, SyncResult, SyncState } from './types';
import type { FileEntry, FileManifest } from '../protocol/sync-types';
import { runInitialImport } from './initial-import';
import { finishInitialSetup } from './initial-setup';
import type { InitialConfigPull } from './initial-config-pull';

interface SyncEngineContextDependencies {
	prepareReminderScope?: () => Promise<void>;
	vault: Vault;
	fileManager: FileManager;
	api: SyncApiClient;
	files: EngineFileOperations;
	getLocalManifest: () => LocalManifest;
	markdownBaseCache: MarkdownBaseCache;
	conflictStore: ConflictStore;
	getSettings: () => CrateSettings;
	getStatus: () => SyncState['status'];
	shouldIgnore: (path: string) => boolean;
	runConcurrent: <T>(tasks: (() => Promise<T>)[], concurrency: number) => Promise<T[]>;
	retryWithBackoff: <T>(fn: () => Promise<T>) => Promise<T>;
	getModifiedIso: (path: string, fallbackMtime?: number) => Promise<string>;
	getPendingPaths: () => string[];
	verifyContent: (files: VaultFile[]) => Promise<boolean>;
	reconcileVersionConflicts: (paths: string[], result: SyncResult) => Promise<void>;
	updateState: (updates: Partial<SyncState>) => void;
	isAbortError: (error: unknown) => boolean;
	throwIfDestroyed: () => void;
}

export class SyncEngineContexts {
	private readonly plannedContent = new PlannedContent();
	clearPlannedContent(): void { this.plannedContent.clear(); }
	constructor(private dependencies: SyncEngineContextDependencies) {}

	async prepareUploadFromPath(path: string): Promise<PreparedUpload | null> {
		return prepareTransferUploadFromPath(this.transfer(), path);
	}

	private async getLocalDeletes(): Promise<string[]> {
		return planLocalDeletes(this.localDiffPlanner(), PREPARE_CONCURRENCY);
	}

	async incrementalSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult | null> {
		return runIncrementalSync(this.incrementalPlanner(), {
			uploadConcurrency: UPLOAD_CONCURRENCY,
			progressCallback,
		});
	}

	private async getLocalChanges(onUnchanged?: (path: string) => void): Promise<{ path: string; hash: string }[]> {
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

	private transfer() {
		const dependencies = this.dependencies;
		return {
			vault: dependencies.vault,
			plannedContent: this.plannedContent,
			fileManager: dependencies.fileManager,
			api: dependencies.files,
			localManifest: dependencies.getLocalManifest(),
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
			localManifest: dependencies.getLocalManifest(),
			shouldIgnore: dependencies.shouldIgnore,
			verifyContent: dependencies.verifyContent,
			runConcurrent: dependencies.runConcurrent,
		};
	}

	private incrementalPlanner() {
		const dependencies = this.dependencies;
		return {
			settings: dependencies.getSettings(),
			reportWork: (phase: import('./types').SyncWork['phase'], current?: number, total?: number) => dependencies.updateState({ work: { phase, current, total } }),
			throwIfDestroyed: dependencies.throwIfDestroyed,
			vault: dependencies.vault,
			fileManager: dependencies.fileManager,
			api: dependencies.files,
			localManifest: dependencies.getLocalManifest(),
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
				get: () => dependencies.getLocalManifest().getInitialConfigPull(),
				save: async (state: InitialConfigPull) => {
					const manifest = dependencies.getLocalManifest();
					manifest.setInitialConfigPull(state);
					await manifest.save();
				},
			},
			throwIfDestroyed: dependencies.throwIfDestroyed,
			vault: dependencies.vault,
			plannedContent: this.plannedContent,
			localManifest: dependencies.getLocalManifest(),
			shouldIgnore: dependencies.shouldIgnore,
			runConcurrent: dependencies.runConcurrent,
		};
	}

	syncWorkflow() {
		const dependencies = this.dependencies;
		return {
      finishInitialSetup: () => this.finishInitialSetup(),
      tryInitialImport: (result: import('./types').SyncResult, progress?: (current: number, total: number) => void) => this.tryInitialImport(result, progress),
			apiConfigured: () => dependencies.api.isConfigured(),
			reportWork: (phase: import('./types').SyncWork['phase'], current?: number, total?: number) => dependencies.updateState({ work: { phase, current, total } }),
			recoverUploads: () => dependencies.files.recoverUploads((current, total) => dependencies.updateState({ work: { phase: 'recovering', current, total } })),
			getStatus: dependencies.getStatus,
			updateState: dependencies.updateState,
			getManifest: () => dependencies.api.getManifest(),
			incrementalSync: this.incrementalSync.bind(this),
			isAbortError: dependencies.isAbortError,
			throwIfDestroyed: dependencies.throwIfDestroyed,
			createFullSyncPlan: (remoteFiles: Record<string, FileEntry>, concurrency: number) =>
				createFullSyncPlan(this.fullSyncPlanner(), remoteFiles, concurrency),
			processDiff: this.processDiff.bind(this),
			prepareFullSyncUpload: (diff: UploadDiff) => prepareTransferUploadFromPath(this.transfer(), diff.path, { force: true, expectedHash: diff.remoteHash ?? null }),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			reconcileVersionConflicts: dependencies.reconcileVersionConflicts,
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles.bind(this),
			getLocalManifestEntry: (path: string) => dependencies.getLocalManifest().getEntry(path),
			setLocalManifestEntry: (path: string, entry: FileEntry) => {
				dependencies.getLocalManifest().setEntry(path, entry);
			},
			saveLocalManifest: () => dependencies.getLocalManifest().save(),
			setLastSync: (value: string) => {
				dependencies.getSettings().lastSync = value;
			},
			setLastSeq: (value: number) => {
				dependencies.getSettings().lastSeq = value;
			},
		};
	}

	initialSyncWorkflow() {
		const dependencies = this.dependencies;
		return {
      finishInitialSetup: () => this.finishInitialSetup(),
      tryInitialImport: (result: import('./types').SyncResult, progress?: (current: number, total: number) => void) => this.tryInitialImport(result, progress),
			vault: dependencies.vault,
			apiConfigured: () => dependencies.api.isConfigured(),
			reportWork: (phase: import('./types').SyncWork['phase'], current?: number, total?: number) => dependencies.updateState({ work: { phase, current, total } }),
			recoverUploads: () => dependencies.files.recoverUploads((current, total) => dependencies.updateState({ work: { phase: 'recovering', current, total } })),
			getStatus: dependencies.getStatus,
			updateState: dependencies.updateState,
			shouldIgnore: dependencies.shouldIgnore,
			isAbortError: dependencies.isAbortError,
			prepareUploadsFromVaultFiles: this.prepareUploadsFromVaultFiles.bind(this),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			createVaultFileChunks: createByteBudgetedVaultFileChunks,
			saveLocalManifest: () => dependencies.getLocalManifest().save(),
			throwIfDestroyed: dependencies.throwIfDestroyed,
			setLastSync: (value: string) => {
				dependencies.getSettings().lastSync = value;
			},
		};
	}

	finishInitialSetup(): Promise<void> {
		const dependencies = this.dependencies;
		return finishInitialSetup({
			manifest: dependencies.getLocalManifest(), lastSeq: dependencies.getSettings().lastSeq,
			initialImport: dependencies.api.initialImport, prepareReminderScope: dependencies.prepareReminderScope,
			reportWork: work => dependencies.updateState({ work }), assertActive: dependencies.throwIfDestroyed,
		});
	}

  private tryInitialImport(result: import('./types').SyncResult, progress?: (current: number, total: number) => void) {
    const dependencies = this.dependencies;
    return runInitialImport({ transfer: this.transfer(), api: dependencies.api,
      prepareReminderScope: dependencies.prepareReminderScope,
      shouldIgnore: dependencies.shouldIgnore, throwIfDestroyed: dependencies.throwIfDestroyed,
      save: () => dependencies.getLocalManifest().save(),
      setLastSeq: seq => { dependencies.getSettings().lastSeq = seq; },
      report: work => dependencies.updateState({ work }),
    }, result, progress);
  }

	forceSyncWorkflow() {
		const dependencies = this.dependencies;
		return {
      finishInitialSetup: () => this.finishInitialSetup(),
			vault: dependencies.vault,
			apiConfigured: () => dependencies.api.isConfigured(),
			reportWork: (phase: import('./types').SyncWork['phase'], current?: number, total?: number) => dependencies.updateState({ work: { phase, current, total } }),
			recoverUploads: () => dependencies.files.recoverUploads((current, total) => dependencies.updateState({ work: { phase: 'recovering', current, total } })),
			getStatus: dependencies.getStatus,
			updateState: dependencies.updateState,
			shouldIgnore: dependencies.shouldIgnore,
			isAbortError: dependencies.isAbortError,
			getManifest: () => dependencies.api.getManifest(),
			snapshotLocalManifest: () => structuredClone(dependencies.getLocalManifest().getManifest()),
			clearLocalManifest: () => dependencies.getLocalManifest().clear(),
			replaceLocalManifest: (manifest: FileManifest) => dependencies.getLocalManifest().replaceManifest(manifest),
			prepareUploadsFromVaultFiles: this.prepareUploadsFromVaultFiles.bind(this),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			createVaultFileChunks: createByteBudgetedVaultFileChunks,
			throwIfDestroyed: dependencies.throwIfDestroyed,
			deleteRemoteFile: async (path: string, expectedHash: string, expectedRevision?: string) => {
				await dependencies.files.deleteFile(path, expectedHash, expectedRevision);
			},
			removeLocalManifestEntry: (path: string) => dependencies.getLocalManifest().removeEntry(path),
			saveLocalManifest: () => dependencies.getLocalManifest().save(),
			setLastSync: (value: string) => {
				dependencies.getSettings().lastSync = value;
			},
		};
	}
}
