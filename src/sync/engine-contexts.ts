import type { FileManager, Vault } from 'obsidian';
import type { SyncApiClient } from './api';
import type { LocalManifest } from './manifest';
import type { MarkdownBaseCache } from './markdown-base-cache';
import type { ConflictStore } from './conflict-store';
import type { DownloadRequest } from './transfer-download';
import type { DiffApplyOutcome } from './transfer-types';
import type { VaultFile } from './file-discovery';
import type { UploadPreparedFilesOptions } from './transfer-upload';
import { createFullSyncPlan } from './planner';
import type { CrateSettings } from '../plugin/settings-types';
import type { FileDiff, PreparedUpload, SyncResult, SyncState } from './types';
import type { FileEntry, FileManifest } from '../protocol/sync-types';

interface SyncEngineContextDependencies {
	vault: Vault;
	fileManager: FileManager;
	api: SyncApiClient;
	getLocalManifest: () => LocalManifest;
	markdownBaseCache: MarkdownBaseCache;
	conflictStore: ConflictStore;
	getSettings: () => CrateSettings;
	getStatus: () => SyncState['status'];
	shouldIgnore: (path: string) => boolean;
	runConcurrent: <T>(tasks: (() => Promise<T>)[], concurrency: number) => Promise<T[]>;
	retryWithBackoff: <T>(fn: () => Promise<T>) => Promise<T>;
	getModifiedIso: (path: string, fallbackMtime?: number) => Promise<string>;
	getLocalChanges: () => Promise<{ path: string; hash: string }[]>;
	getLocalDeletes: () => Promise<string[]>;
	incrementalSync: (progressCallback?: (current: number, total: number) => void) => Promise<SyncResult | null>;
	parallelDownloadAndSaveFiles: (requests: string[] | DownloadRequest[], result: SyncResult) => Promise<void>;
	processDiff: (diff: FileDiff, localFiles: Record<string, FileEntry>, result: SyncResult) => Promise<DiffApplyOutcome>;
	prepareUploadFromPath: (path: string) => Promise<PreparedUpload | null>;
	uploadPreparedFiles: (
		prepared: PreparedUpload[],
		result: SyncResult,
		options: UploadPreparedFilesOptions,
	) => Promise<void>;
	reconcileVersionConflicts: (paths: string[], result: SyncResult) => Promise<void>;
	prepareUploadsFromVaultFiles: (
		files: VaultFile[],
		onPrepared?: (completed: number) => void,
	) => Promise<PreparedUpload[]>;
	createVaultFileChunks: (files: VaultFile[]) => VaultFile[][];
	updateState: (updates: Partial<SyncState>) => void;
	isAbortError: (error: unknown) => boolean;
	throwIfDestroyed: () => void;
}

export class SyncEngineContexts {
	constructor(private dependencies: SyncEngineContextDependencies) {}

	transfer() {
		const dependencies = this.dependencies;
		return {
			vault: dependencies.vault,
			fileManager: dependencies.fileManager,
			api: dependencies.api,
			localManifest: dependencies.getLocalManifest(),
			markdownBaseCache: dependencies.markdownBaseCache,
			conflictStore: dependencies.conflictStore,
			runConcurrent: dependencies.runConcurrent,
			retryWithBackoff: dependencies.retryWithBackoff,
			getModifiedIso: dependencies.getModifiedIso,
		};
	}

	localDiffPlanner() {
		const dependencies = this.dependencies;
		return {
			vault: dependencies.vault,
			localManifest: dependencies.getLocalManifest(),
			shouldIgnore: dependencies.shouldIgnore,
			runConcurrent: dependencies.runConcurrent,
		};
	}

	incrementalPlanner() {
		const dependencies = this.dependencies;
		return {
			settings: dependencies.getSettings(),
			vault: dependencies.vault,
			fileManager: dependencies.fileManager,
			api: dependencies.api,
			localManifest: dependencies.getLocalManifest(),
			shouldIgnore: dependencies.shouldIgnore,
			getLocalChanges: dependencies.getLocalChanges,
			getLocalDeletes: dependencies.getLocalDeletes,
			parallelDownloadAndSaveFiles: dependencies.parallelDownloadAndSaveFiles,
			processDiff: dependencies.processDiff,
			prepareUploadFromPath: dependencies.prepareUploadFromPath,
			uploadPreparedFiles: dependencies.uploadPreparedFiles,
			reconcileVersionConflicts: dependencies.reconcileVersionConflicts,
		};
	}

	fullSyncPlanner() {
		const dependencies = this.dependencies;
		return {
			vault: dependencies.vault,
			localManifest: dependencies.getLocalManifest(),
			shouldIgnore: dependencies.shouldIgnore,
			runConcurrent: dependencies.runConcurrent,
		};
	}

	syncWorkflow() {
		const dependencies = this.dependencies;
		return {
			apiConfigured: () => dependencies.api.isConfigured(),
			getStatus: dependencies.getStatus,
			updateState: dependencies.updateState,
			getManifest: () => dependencies.api.getManifest(),
			incrementalSync: dependencies.incrementalSync,
			isAbortError: dependencies.isAbortError,
			throwIfDestroyed: dependencies.throwIfDestroyed,
			createFullSyncPlan: (remoteFiles: Record<string, FileEntry>, concurrency: number) =>
				createFullSyncPlan(this.fullSyncPlanner(), remoteFiles, concurrency),
			processDiff: dependencies.processDiff,
			parallelDownloadAndSaveFiles: dependencies.parallelDownloadAndSaveFiles,
			runConcurrent: dependencies.runConcurrent,
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
			vault: dependencies.vault,
			apiConfigured: () => dependencies.api.isConfigured(),
			getStatus: dependencies.getStatus,
			updateState: dependencies.updateState,
			shouldIgnore: dependencies.shouldIgnore,
			isAbortError: dependencies.isAbortError,
			prepareUploadsFromVaultFiles: dependencies.prepareUploadsFromVaultFiles,
			uploadPreparedFiles: dependencies.uploadPreparedFiles,
			createVaultFileChunks: dependencies.createVaultFileChunks,
			saveLocalManifest: () => dependencies.getLocalManifest().save(),
			throwIfDestroyed: dependencies.throwIfDestroyed,
			setLastSync: (value: string) => {
				dependencies.getSettings().lastSync = value;
			},
		};
	}

	forceSyncWorkflow() {
		const dependencies = this.dependencies;
		return {
			vault: dependencies.vault,
			apiConfigured: () => dependencies.api.isConfigured(),
			getStatus: dependencies.getStatus,
			updateState: dependencies.updateState,
			shouldIgnore: dependencies.shouldIgnore,
			isAbortError: dependencies.isAbortError,
			getManifest: () => dependencies.api.getManifest(),
			snapshotLocalManifest: () => structuredClone(dependencies.getLocalManifest().getManifest()),
			clearLocalManifest: () => dependencies.getLocalManifest().clear(),
			replaceLocalManifest: (manifest: FileManifest) => dependencies.getLocalManifest().replaceManifest(manifest),
			prepareUploadsFromVaultFiles: dependencies.prepareUploadsFromVaultFiles,
			uploadPreparedFiles: dependencies.uploadPreparedFiles,
			createVaultFileChunks: dependencies.createVaultFileChunks,
			throwIfDestroyed: dependencies.throwIfDestroyed,
			deleteRemoteFile: async (path: string, expectedHash: string) => {
				await dependencies.api.deleteFile(path, expectedHash);
			},
			removeLocalManifestEntry: (path: string) => dependencies.getLocalManifest().removeEntry(path),
			saveLocalManifest: () => dependencies.getLocalManifest().save(),
			setLastSync: (value: string) => {
				dependencies.getSettings().lastSync = value;
			},
		};
	}
}
