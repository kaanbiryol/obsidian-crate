/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import { type Plugin, type TAbstractFile, type Vault } from 'obsidian';
import { SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import { MarkdownBaseCache } from './markdown-base-cache';
import type { VaultFile } from './file-discovery';
import type { DownloadRequest } from './transfer-download';
import { SyncQueueController } from './queue-controller';
import { isAbortError as isSyncAbortError } from './abort';
import {
	getLocalChanges as planLocalChanges,
	getLocalDeletes as planLocalDeletes,
	runIncrementalSync,
	createFullSyncPlan,
} from './planner';
import {
	prepareUploadFromPath as prepareTransferUploadFromPath,
	parallelDownloadAndSaveFiles as transferParallelDownloadAndSaveFiles,
	processDiff as transferProcessDiff,
	prepareUploadsFromVaultFiles as transferPrepareUploadsFromVaultFiles,
	uploadPreparedFiles as transferUploadPreparedFiles,
	createVaultFileChunks as transferCreateVaultFileChunks,
} from './transfer';
import { createLogger, errorMessage } from '../plugin/logger';
import type {
	SyncState,
	SyncResult,
	FileDiff,
	PreparedUpload,
	FileEntry,
	CrateSettings,
} from '../plugin/types';
import { MAX_DEBOUNCE_WAIT_MS } from '../plugin/types';
import {
	DOWNLOAD_CONCURRENCY,
	MAX_RETRIES,
	PREPARE_CONCURRENCY,
	RETRY_BASE_DELAY_MS,
	UPLOAD_CONCURRENCY,
} from './engine-constants';
import { shouldIgnoreSyncPath } from './engine-ignore';
import { hasHiddenFileChanges } from './hidden-file-changes';
import { retryWithBackoff, runConcurrentTasks } from './engine-utils';
import {
	runForceFullSyncWorkflow,
	runInitialSyncWorkflow,
	runPeriodicCheckWorkflow,
	runSyncWorkflow,
} from './engine-workflows';

const logger = createLogger('SyncEngine');

export class SyncEngine {
	private plugin: Plugin;
	private vault: Vault;
	private api: SyncApiClient;
	private localManifest: LocalManifest;
	private markdownBaseCache: MarkdownBaseCache;
	private settings: CrateSettings;
	private state: SyncState;
	private queueController: SyncQueueController;
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	private onStateChange: ((state: SyncState) => void) | null = null;
	private patternCache = new Map<string, RegExp>();
	private ignoredDirPrefixes: string[] = [];
	private destroyed = false;
	private abortController = new AbortController();
	private consecutiveCheckFailures = 0;
	private lastCheckAttempt = 0;

	constructor(
		plugin: Plugin,
		api: SyncApiClient,
		settings: CrateSettings
	) {
		this.plugin = plugin;
		this.vault = plugin.app.vault;
		this.api = api;
		this.settings = settings;
		this.localManifest = new LocalManifest(plugin.app, plugin.manifest);
		this.markdownBaseCache = new MarkdownBaseCache(plugin.app, plugin.manifest);
		this.ignoredDirPrefixes = this.getIgnoredDirPrefixes(settings);
		this.api.setAbortSignal(this.abortController.signal);
		this.state = {
			status: 'idle',
			lastSync: settings.lastSync,
			lastError: null,
			pendingChanges: 0,
			conflictCount: 0,
		};
		this.queueController = new SyncQueueController({
			api: this.api,
			getLocalManifest: () => this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			shouldIgnore: this.shouldIgnore.bind(this),
			updateState: this.updateState.bind(this),
			isDestroyed: () => this.destroyed,
			currentStatus: () => this.state.status,
			prepareUploadFromPath: (path: string) => this.prepareUploadFromPath(path),
			runConcurrent: this.runConcurrent.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
			getDebounceDelayMs: () => (this.settings.debounceDelay ?? 5) * 1000,
			uploadConcurrency: UPLOAD_CONCURRENCY,
			maxDebounceWaitMs: MAX_DEBOUNCE_WAIT_MS,
		});
	}

	async initialize(): Promise<void> {
		await this.localManifest.load();
		logger.info('Engine initialized');
		this.seedMarkdownBaseCacheInBackground();

		if (this.settings.syncInterval > 0) {
			this.startPeriodicSync();
		}
	}

	setStateChangeCallback(callback: (state: SyncState) => void): void {
		this.onStateChange = callback;
	}

	updateSettings(settings: CrateSettings): void {
		this.patternCache.clear();
		this.settings = settings;
		this.ignoredDirPrefixes = this.getIgnoredDirPrefixes(settings);
		this.consecutiveCheckFailures = 0;
		this.lastCheckAttempt = 0;

		this.stopPeriodicSync();
		if (settings.syncInterval > 0) {
			this.startPeriodicSync();
		}
	}

	getState(): SyncState {
		return { ...this.state };
	}

	getPendingPaths(): string[] {
		return this.queueController.getPendingPaths();
	}

	private startPeriodicSync(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
		}
		this.syncInterval = setInterval(
			() => { void this.periodicCheck(); },
			this.settings.syncInterval * 1000
		);
	}

	private async periodicCheck(): Promise<void> {
		await runPeriodicCheckWorkflow(this.getPeriodicCheckWorkflowContext());
	}

	private stopPeriodicSync(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}
	}

	private updateState(updates: Partial<SyncState>): void {
		this.state = { ...this.state, ...updates };
		this.onStateChange?.(this.state);
	}

	private shouldIgnore(path: string): boolean {
		return shouldIgnoreSyncPath(path, {
			ignoredDirPrefixes: this.ignoredDirPrefixes,
			ignorePatterns: this.settings.ignorePatterns,
			patternCache: this.patternCache,
		});
	}

	private getIgnoredDirPrefixes(settings: CrateSettings): string[] {
		const configDir = this.vault.configDir.replace(/\/+$/, '');
		const pluginDir = this.plugin.manifest.dir?.replace(/\/+$/, '');
		return [...new Set([
			`${configDir}/plugins/`,
			...(pluginDir ? [`${pluginDir}/`] : []),
			...settings.ignorePatterns.filter(p => p.endsWith('/')),
			this.markdownBaseCache.getIgnoredPrefix(),
		])];
	}

	private seedMarkdownBaseCacheInBackground(): void {
		void this.markdownBaseCache.seedFromManifest(this.localManifest, {
			isDestroyed: () => this.destroyed,
			runConcurrent: this.runConcurrent.bind(this),
		}).catch((error) => {
			logger.warn('Markdown base cache seed failed:', errorMessage(error));
		});
	}

	private pruneMarkdownBaseCacheInBackground(): void {
		void this.markdownBaseCache.pruneUnreferenced(this.localManifest).catch((error) => {
			logger.warn('Markdown base cache prune failed:', errorMessage(error));
		});
	}

	private throwIfDestroyed(): void {
		if (this.destroyed) {
			throw new DOMException('Sync engine destroyed', 'AbortError');
		}
	}

	private isAbortError(error: unknown): boolean {
		return isSyncAbortError(error);
	}

	private getTransferContext() {
		return {
			vault: this.vault,
			fileManager: this.plugin.app.fileManager,
			api: this.api,
			localManifest: this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			runConcurrent: this.runConcurrent.bind(this),
			retryWithBackoff: this.retryWithBackoff.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
		};
	}

	onFileChange(file: TAbstractFile): void {
		this.queueController.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		this.queueController.onFileDelete(file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		this.queueController.onFileRename(file, oldPath);
	}

	private async prepareUploadFromPath(path: string): Promise<PreparedUpload | null> {
		return prepareTransferUploadFromPath(this.getTransferContext(), path);
	}

	private async runConcurrent<T>(
		tasks: (() => Promise<T>)[],
		concurrency: number
	): Promise<T[]> {
		return runConcurrentTasks(tasks, concurrency, () => this.destroyed);
	}

	private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
		return retryWithBackoff(fn, {
			maxRetries: MAX_RETRIES,
			baseDelayMs: RETRY_BASE_DELAY_MS,
			isAbortError: this.isAbortError.bind(this),
			isDestroyed: () => this.destroyed,
		});
	}

	private async getModifiedIso(path: string, fallbackMtime?: number): Promise<string> {
		if (typeof fallbackMtime === 'number' && Number.isFinite(fallbackMtime)) {
			return new Date(fallbackMtime).toISOString();
		}

		const stat = await this.vault.adapter.stat(path);
		return new Date(stat?.mtime ?? Date.now()).toISOString();
	}

	private getLocalDiffPlannerContext() {
		return {
			vault: this.vault,
			localManifest: this.localManifest,
			shouldIgnore: this.shouldIgnore.bind(this),
			runConcurrent: this.runConcurrent.bind(this),
		};
	}

	private getIncrementalPlannerContext() {
		return {
			settings: this.settings,
			vault: this.vault,
			fileManager: this.plugin.app.fileManager,
			api: this.api,
			localManifest: this.localManifest,
			shouldIgnore: this.shouldIgnore.bind(this),
			getLocalChanges: () => this.getLocalChanges(),
			getLocalDeletes: () => this.getLocalDeletes(),
			parallelDownloadAndSaveFiles: (requests: string[] | DownloadRequest[], result: SyncResult) =>
				this.parallelDownloadAndSaveFiles(requests, result),
			processDiff: (
				diff: FileDiff,
				localFiles: Record<string, FileEntry>,
				result: SyncResult,
			) => this.processDiff(diff, localFiles, result),
			prepareUploadFromPath: (path: string) => this.prepareUploadFromPath(path),
			uploadPreparedFiles: (
				prepared: PreparedUpload[],
				result: SyncResult,
				options: { concurrency: number; retry: boolean },
			) => this.uploadPreparedFiles(prepared, result, options),
		};
	}

	private getFullSyncPlannerContext() {
		return {
			vault: this.vault,
			localManifest: this.localManifest,
			shouldIgnore: this.shouldIgnore.bind(this),
			runConcurrent: this.runConcurrent.bind(this),
		};
	}

	private getPeriodicCheckWorkflowContext() {
		return {
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			getSyncIntervalSeconds: () => this.settings.syncInterval,
			getLastSeq: () => this.settings.lastSeq,
			getPendingPathCount: () => this.queueController.getPendingPathCount(),
			getConsecutiveCheckFailures: () => this.consecutiveCheckFailures,
			setConsecutiveCheckFailures: (value: number) => {
				this.consecutiveCheckFailures = value;
			},
			getLastCheckAttempt: () => this.lastCheckAttempt,
			setLastCheckAttempt: (value: number) => {
				this.lastCheckAttempt = value;
			},
			hasHiddenFileChanges: () => hasHiddenFileChanges(
				this.vault,
				this.localManifest,
				this.shouldIgnore.bind(this),
			),
			checkForChanges: (lastSeq: number) => this.api.checkForChanges(lastSeq),
			sync: () => this.sync(),
		};
	}

	private getSyncWorkflowContext() {
		return {
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			updateState: this.updateState.bind(this),
			getManifest: () => this.api.getManifest(),
			incrementalSync: (progressCallback?: (current: number, total: number) => void) =>
				this.incrementalSync(progressCallback),
			isAbortError: this.isAbortError.bind(this),
			throwIfDestroyed: this.throwIfDestroyed.bind(this),
			createFullSyncPlan: (
				remoteFiles: Record<string, FileEntry>,
				concurrency: number,
			) => createFullSyncPlan(this.getFullSyncPlannerContext(), remoteFiles, concurrency),
			processDiff: this.processDiff.bind(this),
			parallelDownloadAndSaveFiles: this.parallelDownloadAndSaveFiles.bind(this),
			runConcurrent: this.runConcurrent.bind(this),
			readBinary: (path: string) => this.vault.adapter.readBinary(path),
			getModifiedIso: this.getModifiedIso.bind(this),
			setLocalManifestEntry: (path: string, entry: FileEntry) => {
				this.localManifest.setEntry(path, entry);
			},
			saveLocalManifest: () => this.localManifest.save(),
			setLastSync: (value: string) => {
				this.settings.lastSync = value;
			},
			setLastSeq: (value: number) => {
				this.settings.lastSeq = value;
			},
		};
	}

	private getInitialSyncWorkflowContext() {
		return {
			vault: this.vault,
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			updateState: this.updateState.bind(this),
			shouldIgnore: this.shouldIgnore.bind(this),
			isAbortError: this.isAbortError.bind(this),
			prepareUploadsFromVaultFiles: this.prepareUploadsFromVaultFiles.bind(this),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			createVaultFileChunks: this.createVaultFileChunks.bind(this),
			saveLocalManifest: () => this.localManifest.save(),
			throwIfDestroyed: this.throwIfDestroyed.bind(this),
			setLastSync: (value: string) => {
				this.settings.lastSync = value;
			},
		};
	}

	private getForceSyncWorkflowContext() {
		return {
			vault: this.vault,
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			updateState: this.updateState.bind(this),
			shouldIgnore: this.shouldIgnore.bind(this),
			isAbortError: this.isAbortError.bind(this),
			getManifest: () => this.api.getManifest(),
			clearLocalManifest: () => {
				this.localManifest.clear();
			},
			prepareUploadsFromVaultFiles: this.prepareUploadsFromVaultFiles.bind(this),
			uploadPreparedFiles: this.uploadPreparedFiles.bind(this),
			throwIfDestroyed: this.throwIfDestroyed.bind(this),
			deleteRemoteFile: async (path: string, expectedHash: string) => {
				await this.api.deleteFile(path, expectedHash);
			},
			removeLocalManifestEntry: (path: string) => {
				this.localManifest.removeEntry(path);
			},
			saveLocalManifest: () => this.localManifest.save(),
			setLastSync: (value: string) => {
				this.settings.lastSync = value;
			},
		};
	}

	private async getLocalDeletes(): Promise<string[]> {
		return planLocalDeletes(this.getLocalDiffPlannerContext(), PREPARE_CONCURRENCY);
	}

	private async incrementalSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult | null> {
		return runIncrementalSync(this.getIncrementalPlannerContext(), {
			uploadConcurrency: UPLOAD_CONCURRENCY,
			progressCallback,
		});
	}

	private async getLocalChanges(): Promise<{ path: string; hash: string }[]> {
		return planLocalChanges(this.getLocalDiffPlannerContext(), PREPARE_CONCURRENCY);
	}

	private async parallelDownloadAndSaveFiles(requests: string[] | DownloadRequest[], result: SyncResult): Promise<void> {
		await transferParallelDownloadAndSaveFiles(
			this.getTransferContext(),
			requests,
			result,
			DOWNLOAD_CONCURRENCY,
		);
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		const result = await runSyncWorkflow(this.getSyncWorkflowContext(), progressCallback);
		this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
		if (result.success) {
			this.pruneMarkdownBaseCacheInBackground();
		}
		return result;
	}

	private async processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<void> {
		await transferProcessDiff(this.getTransferContext(), diff, localFiles, result);
	}

	private async prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void,
	): Promise<PreparedUpload[]> {
		return transferPrepareUploadsFromVaultFiles(
			this.getTransferContext(),
			files,
			PREPARE_CONCURRENCY,
			onPrepared,
		);
	}

	private async uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean; batchConcurrency?: number },
	): Promise<void> {
		await transferUploadPreparedFiles(this.getTransferContext(), prepared, result, options);
	}

	private createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][] {
		return transferCreateVaultFileChunks(files, chunkSize);
	}

	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		const result = await runInitialSyncWorkflow(this.getInitialSyncWorkflowContext(), progressCallback);
		this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
		if (result.success) {
			this.pruneMarkdownBaseCacheInBackground();
		}
		return result;
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		const result = await runForceFullSyncWorkflow(this.getForceSyncWorkflowContext(), progressCallback);
		this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
		if (result.success) {
			this.pruneMarkdownBaseCacheInBackground();
		}
		return result;
	}

	destroy(): void {
		this.destroyed = true;
		this.abortController.abort();
		this.stopPeriodicSync();
		this.queueController.destroy();
	}
}
