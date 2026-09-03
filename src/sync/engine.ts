/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import { type Plugin, type TAbstractFile, type Vault } from 'obsidian';
import { SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import { MarkdownBaseCache } from './markdown-base-cache';
import { ConflictStore } from './conflict-store';
import { isConflictFile } from './conflict';
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
} from './transfer';
import { createByteBudgetedVaultFileChunks } from './transfer-budget';
import { createLogger, errorMessage } from '../plugin/logger';
import type { SyncState, SyncResult, FileDiff, PreparedUpload, ConflictRecord } from './types';
import type { FileEntry } from '../protocol/sync-types';
import type { CrateSettings } from '../plugin/settings-types';
import { MAX_DEBOUNCE_WAIT_MS } from '../plugin/settings-types';
import { DOWNLOAD_CONCURRENCY, PREPARE_CONCURRENCY, UPLOAD_CONCURRENCY } from './engine-constants';
import {
	type IgnoreMatcherContext,
	shouldIgnoreConfiguredPath,
	shouldIgnoreSyncPath,
} from './engine-ignore';
import { hasLocalFileChanges } from './local-file-changes';
import { deleteFilesInBatches } from './delete-batches';
import {
	runForceFullSyncWorkflow,
	runInitialSyncWorkflow,
	runSyncWorkflow,
} from './engine-workflows';
import { SyncEngineContexts } from './engine-contexts';
import { SyncEngineLifecycle } from './engine-lifecycle';
import { reconcileQueuePaths } from './reconcile-paths';
import { createSyncFailureResult } from './sync-result';
import type { DiffApplyOutcome } from './transfer-types';
import type { UploadPreparedFilesOptions } from './transfer-upload';
import { mergeSyncResults } from './sync-result';

const logger = createLogger('SyncEngine');

export class SyncEngine {
	private plugin: Plugin;
	private vault: Vault;
	private api: SyncApiClient;
	private localManifest: LocalManifest;
	private markdownBaseCache: MarkdownBaseCache;
	private conflictStore: ConflictStore;
	private settings: CrateSettings;
	private state: SyncState;
	private queueController: SyncQueueController;
	private lifecycle: SyncEngineLifecycle;
	private contexts: SyncEngineContexts;
	private onStateChange: ((state: SyncState) => void) | null = null;
	private onQueueSyncResult: ((result: SyncResult) => void | Promise<void>) | null = null;
	private patternCache = new Map<string, RegExp>();
	private ignoredDirPrefixes: string[] = [];
	private conflictRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

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
		this.state = {
			status: 'idle',
			lastSync: settings.lastSync,
			lastError: null,
			pendingChanges: 0,
			conflictCount: 0,
		};
		this.conflictStore = new ConflictStore(plugin.app, plugin.manifest, (conflictCount) => {
			this.updateState({ conflictCount });
		});
		this.ignoredDirPrefixes = this.getIgnoredDirPrefixes(settings);
		this.lifecycle = new SyncEngineLifecycle({
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			getSyncIntervalSeconds: () => this.settings.syncInterval,
			getLastSeq: () => this.settings.lastSeq,
			getPendingPathCount: () => this.queueController.getPendingPathCount(),
			hasLocalFileChanges: () => hasLocalFileChanges(
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
			reconcile: (queueKeys) => this.reconcileFromQueue(queueKeys),
			onFlushResult: (result) => this.onQueueSyncResult?.(result),
		});
		this.contexts = new SyncEngineContexts({
			vault: this.vault,
			fileManager: this.plugin.app.fileManager,
			api: this.api,
			getLocalManifest: () => this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			conflictStore: this.conflictStore,
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
			reconcileVersionConflicts: (paths, result) =>
				this.reconcileVersionConflicts(paths, result),
			prepareUploadsFromVaultFiles: (files, onPrepared) =>
				this.prepareUploadsFromVaultFiles(files, onPrepared),
			createVaultFileChunks: files => this.createVaultFileChunks(files),
			updateState: this.updateState.bind(this),
			isAbortError: this.isAbortError.bind(this),
			throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
		});
	}

	async initialize(): Promise<void> {
		await this.localManifest.load();
		await this.conflictStore.load();
		logger.info('Engine initialized');
		this.plugin.app.workspace.onLayoutReady(() => {
			this.scheduleConflictRecovery();
		});
		this.seedMarkdownBaseCacheInBackground();

		this.lifecycle.startPeriodicSync();
	}

	setStateChangeCallback(callback: (state: SyncState) => void): void {
		this.onStateChange = callback;
	}

	setQueueSyncResultCallback(callback: (result: SyncResult) => void | Promise<void>): void {
		this.onQueueSyncResult = callback;
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

	getActiveConflicts(): ConflictRecord[] {
		return this.conflictStore.getActiveConflicts();
	}

	async hasUnsyncedLocalChanges(): Promise<boolean> {
		return hasLocalFileChanges(
			this.vault,
			this.localManifest,
			this.shouldIgnore.bind(this),
		);
	}

	async previewIgnoredRemoteFiles(): Promise<string[]> {
		const manifest = await this.api.getManifest();
		return Object.keys(manifest.files).filter(path => this.shouldIgnore(path)).sort();
	}

	async purgeIgnoredRemoteFiles(): Promise<{ deleted: string[]; errors: string[] }> {
		const manifest = await this.api.getManifest();
		const paths = Object.keys(manifest.files).filter(path => this.shouldIgnore(path)).sort();
		this.lifecycle.throwIfDestroyed();
		const result = await deleteFilesInBatches({
			batchDelete: (batchPaths, expectedHashes) =>
				this.retryWithBackoff(() => this.api.batchDelete(batchPaths, expectedHashes)),
		}, paths.map(path => ({ path, expectedHash: manifest.files[path]!.hash })));
		for (const path of result.deleted) this.localManifest.removeEntry(path);
		await this.localManifest.save();
		return {
			deleted: result.deleted,
			errors: result.errors.map(error => `${error.path}: ${error.error}`),
		};
	}

	private updateState(updates: Partial<SyncState>): void {
		this.state = { ...this.state, ...updates };
		this.onStateChange?.(this.state);
	}

	private shouldIgnore(path: string): boolean {
		return shouldIgnoreSyncPath(path, this.getIgnoreMatcherContext());
	}

	private getIgnoreMatcherContext(): IgnoreMatcherContext {
		return {
			ignoredDirPrefixes: this.ignoredDirPrefixes,
			ignorePatterns: this.settings.ignorePatterns,
			patternCache: this.patternCache,
		};
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

	private recoverConflictStoreInBackground(): void {
		if (this.lifecycle.isDestroyed) return;
		const ignoreMatcherContext = this.getIgnoreMatcherContext();
		void this.conflictStore.recoverFromVault(
			(path) => shouldIgnoreConfiguredPath(path, ignoreMatcherContext),
			() => this.lifecycle.isDestroyed,
		).catch((error) => {
			logger.warn('Conflict recovery failed:', errorMessage(error));
		});
	}

	private scheduleConflictRecovery(): void {
		if (this.lifecycle.isDestroyed || this.conflictRecoveryTimer !== null) return;
		this.conflictRecoveryTimer = setTimeout(() => {
			this.conflictRecoveryTimer = null;
			this.recoverConflictStoreInBackground();
		}, 0);
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
		if (isConflictFile(file.path)) {
			void this.conflictStore.registerDiscovered(file.path).catch((error) => {
				logger.warn('Failed to register conflict copy:', errorMessage(error));
			});
		}
		this.queueController.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		if (isConflictFile(file.path)) {
			void this.conflictStore.markResolved(file.path).catch((error) => {
				logger.warn('Failed to resolve conflict copy:', errorMessage(error));
			});
		}
		this.queueController.onFileDelete(file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (isConflictFile(oldPath)) {
			void this.conflictStore.markResolved(oldPath).catch((error) => {
				logger.warn('Failed to resolve renamed conflict copy:', errorMessage(error));
			});
		}
		if (isConflictFile(file.path)) {
			void this.conflictStore.registerDiscovered(file.path).catch((error) => {
				logger.warn('Failed to register renamed conflict copy:', errorMessage(error));
			});
		}
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

	private async reconcileFromQueue(queueKeys: string[]): Promise<SyncResult> {
		const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
		this.updateState({ status: 'syncing' });
		try {
			const result = await this.reconcilePaths(queueKeys);
			this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
			if (result.success) {
				const lastSync = new Date().toISOString();
				this.settings.lastSync = lastSync;
				this.updateState({
					status: 'idle',
					lastSync,
					lastError: null,
				});
				this.pruneMarkdownBaseCacheInBackground();
			} else {
				this.updateState({ status: 'error', lastError: result.errors[0] ?? 'Reconciliation failed' });
			}
			return result;
		} catch (error) {
			const message = errorMessage(error);
			this.updateState({ status: 'error', lastError: message });
			return createSyncFailureResult(message);
		}
	}

	private async reconcileVersionConflicts(paths: string[], result: SyncResult): Promise<void> {
		const reconciliation = await this.reconcilePaths(paths);
		mergeSyncResults(result, reconciliation);
	}

	private async reconcilePaths(queueKeys: string[]): Promise<SyncResult> {
		return reconcileQueuePaths({
			vault: this.vault,
			localManifest: this.localManifest,
			getRemoteEntries: async (paths) => (await this.api.getFileMetadata(paths)).files,
			shouldIgnore: this.shouldIgnore.bind(this),
			processDiff: (diff, localFiles, syncResult) =>
				this.processDiff(diff, localFiles, syncResult),
		}, queueKeys);
	}

	private async processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<DiffApplyOutcome> {
		return transferProcessDiff(this.contexts.transfer(), diff, localFiles, result);
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
		options: UploadPreparedFilesOptions,
	): Promise<void> {
		await transferUploadPreparedFiles(this.contexts.transfer(), prepared, result, options);
	}

	private createVaultFileChunks(files: VaultFile[]): VaultFile[][] {
		return createByteBudgetedVaultFileChunks(files);
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
		if (this.conflictRecoveryTimer !== null) {
			clearTimeout(this.conflictRecoveryTimer);
			this.conflictRecoveryTimer = null;
		}
		this.lifecycle.destroy();
		this.queueController.destroy();
	}
}
