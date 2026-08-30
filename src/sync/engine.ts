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
import { DOWNLOAD_CONCURRENCY, PREPARE_CONCURRENCY, UPLOAD_CONCURRENCY } from './engine-constants';
import { shouldIgnoreSyncPath } from './engine-ignore';
import { hasHiddenFileChanges } from './hidden-file-changes';
import {
	runForceFullSyncWorkflow,
	runInitialSyncWorkflow,
	runSyncWorkflow,
} from './engine-workflows';
import { SyncEngineContexts } from './engine-contexts';
import { SyncEngineLifecycle } from './engine-lifecycle';

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
	private lifecycle: SyncEngineLifecycle;
	private contexts: SyncEngineContexts;
	private onStateChange: ((state: SyncState) => void) | null = null;
	private patternCache = new Map<string, RegExp>();
	private ignoredDirPrefixes: string[] = [];

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
		this.state = {
			status: 'idle',
			lastSync: settings.lastSync,
			lastError: null,
			pendingChanges: 0,
			conflictCount: 0,
		};
		this.lifecycle = new SyncEngineLifecycle({
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			getSyncIntervalSeconds: () => this.settings.syncInterval,
			getLastSeq: () => this.settings.lastSeq,
			getPendingPathCount: () => this.queueController.getPendingPathCount(),
			hasHiddenFileChanges: () => hasHiddenFileChanges(
				this.vault,
				this.localManifest,
				this.shouldIgnore.bind(this),
			),
			checkForChanges: (lastSeq: number) => this.api.checkForChanges(lastSeq),
			sync: () => this.sync(),
		});
		this.api.setAbortSignal(this.lifecycle.abortSignal);
		this.queueController = new SyncQueueController({
			api: this.api,
			getLocalManifest: () => this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			shouldIgnore: this.shouldIgnore.bind(this),
			updateState: this.updateState.bind(this),
			isDestroyed: () => this.lifecycle.isDestroyed,
			currentStatus: () => this.state.status,
			prepareUploadFromPath: (path: string) => this.prepareUploadFromPath(path),
			runConcurrent: this.runConcurrent.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
			getDebounceDelayMs: () => (this.settings.debounceDelay ?? 5) * 1000,
			uploadConcurrency: UPLOAD_CONCURRENCY,
			maxDebounceWaitMs: MAX_DEBOUNCE_WAIT_MS,
			reconcile: () => this.reconcileFromQueue(),
		});
		this.contexts = new SyncEngineContexts({
			vault: this.vault,
			fileManager: this.plugin.app.fileManager,
			api: this.api,
			getLocalManifest: () => this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			getSettings: () => this.settings,
			getStatus: () => this.state.status,
			shouldIgnore: this.shouldIgnore.bind(this),
			runConcurrent: this.runConcurrent.bind(this),
			retryWithBackoff: this.retryWithBackoff.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
			getLocalChanges: () => this.getLocalChanges(),
			getLocalDeletes: () => this.getLocalDeletes(),
			incrementalSync: (progressCallback) => this.incrementalSync(progressCallback),
			parallelDownloadAndSaveFiles: (requests, result) =>
				this.parallelDownloadAndSaveFiles(requests, result),
			processDiff: (diff, localFiles, result) => this.processDiff(diff, localFiles, result),
			prepareUploadFromPath: (path) => this.prepareUploadFromPath(path),
			uploadPreparedFiles: (prepared, result, options) =>
				this.uploadPreparedFiles(prepared, result, options),
			prepareUploadsFromVaultFiles: (files, onPrepared) =>
				this.prepareUploadsFromVaultFiles(files, onPrepared),
			createVaultFileChunks: (files, chunkSize) => this.createVaultFileChunks(files, chunkSize),
			updateState: this.updateState.bind(this),
			isAbortError: this.isAbortError.bind(this),
			throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
		});
	}

	async initialize(): Promise<void> {
		await this.localManifest.load();
		logger.info('Engine initialized');
		this.seedMarkdownBaseCacheInBackground();

		this.lifecycle.startPeriodicSync();
	}

	setStateChangeCallback(callback: (state: SyncState) => void): void {
		this.onStateChange = callback;
	}

	updateSettings(settings: CrateSettings): void {
		this.patternCache.clear();
		this.settings = settings;
		this.ignoredDirPrefixes = this.getIgnoredDirPrefixes(settings);
		this.lifecycle.settingsChanged();
	}

	getState(): SyncState {
		return { ...this.state };
	}

	getPendingPaths(): string[] {
		return this.queueController.getPendingPaths();
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
			isDestroyed: () => this.lifecycle.isDestroyed,
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

	private isAbortError(error: unknown): boolean {
		return isSyncAbortError(error);
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
		return prepareTransferUploadFromPath(this.contexts.transfer(), path);
	}

	private async runConcurrent<T>(
		tasks: (() => Promise<T>)[],
		concurrency: number
	): Promise<T[]> {
		return this.lifecycle.runConcurrent(tasks, concurrency);
	}

	private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
		return this.lifecycle.retryWithBackoff(fn);
	}

	private async getModifiedIso(path: string, fallbackMtime?: number): Promise<string> {
		if (typeof fallbackMtime === 'number' && Number.isFinite(fallbackMtime)) {
			return new Date(fallbackMtime).toISOString();
		}

		const stat = await this.vault.adapter.stat(path);
		return new Date(stat?.mtime ?? Date.now()).toISOString();
	}

	private async getLocalDeletes(): Promise<string[]> {
		return planLocalDeletes(this.contexts.localDiffPlanner(), PREPARE_CONCURRENCY);
	}

	private async incrementalSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult | null> {
		return runIncrementalSync(this.contexts.incrementalPlanner(), {
			uploadConcurrency: UPLOAD_CONCURRENCY,
			progressCallback,
		});
	}

	private async getLocalChanges(): Promise<{ path: string; hash: string }[]> {
		return planLocalChanges(this.contexts.localDiffPlanner(), PREPARE_CONCURRENCY);
	}

	private async parallelDownloadAndSaveFiles(requests: string[] | DownloadRequest[], result: SyncResult): Promise<void> {
		await transferParallelDownloadAndSaveFiles(
			this.contexts.transfer(),
			requests,
			result,
			DOWNLOAD_CONCURRENCY,
		);
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		const result = await runSyncWorkflow(this.contexts.syncWorkflow(), progressCallback);
		this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
		if (result.success) {
			this.pruneMarkdownBaseCacheInBackground();
		}
		return result;
	}

	private async reconcileFromQueue(): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		const workflowContext = this.contexts.syncWorkflow();
		workflowContext.incrementalSync = async () => null;
		const result = await runSyncWorkflow(workflowContext);
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
		await transferProcessDiff(this.contexts.transfer(), diff, localFiles, result);
	}

	private async prepareUploadsFromVaultFiles(
		files: VaultFile[],
		onPrepared?: (completed: number) => void,
	): Promise<PreparedUpload[]> {
		return transferPrepareUploadsFromVaultFiles(
			this.contexts.transfer(),
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
		await transferUploadPreparedFiles(this.contexts.transfer(), prepared, result, options);
	}

	private createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][] {
		return transferCreateVaultFileChunks(files, chunkSize);
	}

	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		const result = await runInitialSyncWorkflow(this.contexts.initialSyncWorkflow(), progressCallback);
		this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
		if (result.success) {
			this.pruneMarkdownBaseCacheInBackground();
		}
		return result;
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		const result = await runForceFullSyncWorkflow(this.contexts.forceSyncWorkflow(), progressCallback);
		this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
		if (result.success) {
			this.pruneMarkdownBaseCacheInBackground();
		}
		return result;
	}

	destroy(): void {
		this.lifecycle.destroy();
		this.queueController.destroy();
	}
}
