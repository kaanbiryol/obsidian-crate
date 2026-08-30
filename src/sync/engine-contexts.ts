import type { FileManager, Vault } from 'obsidian';
import type { SyncApiClient } from './api';
import type { LocalManifest } from './manifest';
import type { MarkdownBaseCache } from './markdown-base-cache';
import type { DownloadRequest } from './transfer-download';
import type { VaultFile } from './file-discovery';
import { createFullSyncPlan } from './planner';
import type {
	CrateSettings,
	FileDiff,
	FileEntry,
	PreparedUpload,
	SyncResult,
	SyncState,
} from '../plugin/types';

interface SyncEngineContextDependencies {
	vault: Vault;
	fileManager: FileManager;
	api: SyncApiClient;
	getLocalManifest: () => LocalManifest;
	markdownBaseCache: MarkdownBaseCache;
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
	processDiff: (diff: FileDiff, localFiles: Record<string, FileEntry>, result: SyncResult) => Promise<void>;
	prepareUploadFromPath: (path: string) => Promise<PreparedUpload | null>;
	uploadPreparedFiles: (
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean; batchConcurrency?: number },
	) => Promise<void>;
	prepareUploadsFromVaultFiles: (
		files: VaultFile[],
		onPrepared?: (completed: number) => void,
	) => Promise<PreparedUpload[]>;
	createVaultFileChunks: (files: VaultFile[], chunkSize: number) => VaultFile[][];
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
			readBinary: (path: string) => dependencies.vault.adapter.readBinary(path),
			getModifiedIso: dependencies.getModifiedIso,
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
			clearLocalManifest: () => dependencies.getLocalManifest().clear(),
			prepareUploadsFromVaultFiles: dependencies.prepareUploadsFromVaultFiles,
			uploadPreparedFiles: dependencies.uploadPreparedFiles,
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
