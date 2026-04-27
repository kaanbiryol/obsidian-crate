/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import { type Plugin, type TAbstractFile, type Vault } from 'obsidian';
import { SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import type { VaultFile } from './file-discovery';
import {
	onRawPathChange as queueOnRawPathChange,
	onFileChange as queueOnFileChange,
	onFileDelete as queueOnFileDelete,
	onFileRename as queueOnFileRename,
	debouncedSync as runDebouncedQueueSync,
	processPendingChanges as flushPendingQueueChanges,
	type RawPathKind,
} from './queue';
import {
	getLocalChanges as planLocalChanges,
	getLocalDeletes as planLocalDeletes,
	runIncrementalSync,
	createFullSyncPlan,
} from './planner';
import {
	prepareUploadFromPath as prepareTransferUploadFromPath,
	downloadAndSaveFile as transferDownloadAndSaveFile,
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
import { matchIgnorePattern, shouldIgnoreSyncPath } from './engine-ignore';
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
	private settings: CrateSettings;
	private state: SyncState;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private maxWaitStart: number | null = null;
	private pendingPaths: Set<string> = new Set();
	private inFlightPaths: Set<string> = new Set();
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	private onStateChange: ((state: SyncState) => void) | null = null;
	private patternCache = new Map<string, RegExp>();
	private ignoredDirPrefixes: string[] = [];
	private pluginIgnorePaths: Set<string>;
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
		this.ignoredDirPrefixes = settings.ignorePatterns.filter(p => p.endsWith('/'));
		const dir = plugin.manifest.dir ?? '';
		this.pluginIgnorePaths = new Set([
			`${dir}/data.json`,
			`${dir}/file-manifest.json`,
			`${dir}/reminders-settings.json`,
		]);
		this.api.setAbortSignal(this.abortController.signal);
		this.state = {
			status: 'idle',
			lastSync: settings.lastSync,
			lastError: null,
			pendingChanges: 0,
			conflictCount: 0,
		};
	}

	async initialize(): Promise<void> {
		await this.localManifest.load();
		logger.info('Engine initialized');

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
		this.ignoredDirPrefixes = settings.ignorePatterns.filter(p => p.endsWith('/'));
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
		const combined = new Set(this.pendingPaths);
		for (const p of this.inFlightPaths) combined.add(p);
		return Array.from(combined);
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
			pluginIgnorePaths: this.pluginIgnorePaths,
			ignoredDirPrefixes: this.ignoredDirPrefixes,
			ignorePatterns: this.settings.ignorePatterns,
			patternCache: this.patternCache,
		});
	}

	private matchPattern(path: string, pattern: string): boolean {
		return matchIgnorePattern(path, pattern, this.patternCache);
	}

	private throwIfDestroyed(): void {
		if (this.destroyed) {
			throw new DOMException('Sync engine destroyed', 'AbortError');
		}
	}

	private isAbortError(error: unknown): boolean {
		return error instanceof DOMException && error.name === 'AbortError';
	}

	private getTransferContext() {
		return {
			vault: this.vault,
			api: this.api,
			localManifest: this.localManifest,
			runConcurrent: this.runConcurrent.bind(this),
			retryWithBackoff: this.retryWithBackoff.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
		};
	}

	private getQueueEventContext() {
		return {
			pendingPaths: this.pendingPaths,
			shouldIgnore: this.shouldIgnore.bind(this),
			triggerDebouncedSync: () => this.debouncedSync(),
		};
	}

	private getQueueDebounceContext() {
		return {
			pendingPaths: this.pendingPaths,
			isDestroyed: () => this.destroyed,
			getDebounceTimer: () => this.debounceTimer,
			setDebounceTimer: (timer: ReturnType<typeof setTimeout> | null) => {
				this.debounceTimer = timer;
			},
			getMaxWaitStart: () => this.maxWaitStart,
			setMaxWaitStart: (time: number | null) => {
				this.maxWaitStart = time;
			},
			updateState: this.updateState.bind(this),
			processPendingChanges: () => this.processPendingChanges(),
		};
	}

	private getQueueFlushContext() {
		return {
			pendingPaths: this.pendingPaths,
			inFlightPaths: this.inFlightPaths,
			vault: this.vault,
			api: this.api,
			localManifest: this.localManifest,
			updateState: this.updateState.bind(this),
			isDestroyed: () => this.destroyed,
			currentStatus: () => this.state.status,
			prepareUploadFromPath: (path: string) => this.prepareUploadFromPath(path),
			runConcurrent: this.runConcurrent.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
			triggerDebouncedSync: () => this.debouncedSync(),
		};
	}

	onRawFileEvent(path: string): void {
		void this.handleRawFileEvent(path);
	}

	private async handleRawFileEvent(path: string): Promise<void> {
		if (this.destroyed) return;
		const kind = await this.getRawPathKind(path);
		const wasTracked = kind === 'missing' ? this.localManifest.hasFile(path) : false;
		queueOnRawPathChange(this.getQueueEventContext(), path, { kind, wasTracked });
	}

	private async getRawPathKind(path: string): Promise<RawPathKind> {
		try {
			const stat = await this.vault.adapter.stat(path);
			if (stat?.type === 'file') return 'file';
			if (stat?.type === 'folder') return 'folder';
			return 'missing';
		} catch (error) {
			logger.warn(
				`Raw event stat failed for ${path}:`,
				errorMessage(error),
			);
			return 'missing';
		}
	}

	onFileChange(file: TAbstractFile): void {
		queueOnFileChange(this.getQueueEventContext(), file);
	}

	onFileDelete(file: TAbstractFile): void {
		queueOnFileDelete(this.getQueueEventContext(), file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		queueOnFileRename(this.getQueueEventContext(), file, oldPath);
	}

	private debouncedSync(): void {
		const delayMs = (this.settings.debounceDelay ?? 5) * 1000;
		runDebouncedQueueSync(this.getQueueDebounceContext(), delayMs, MAX_DEBOUNCE_WAIT_MS);
	}

	private async processPendingChanges(): Promise<void> {
		await flushPendingQueueChanges(this.getQueueFlushContext(), UPLOAD_CONCURRENCY);
	}

	private clearDebounceTimer(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.maxWaitStart = null;
	}

	private clearSyncedPendingPaths(result: SyncResult): void {
		if (!result.success || this.pendingPaths.size === 0) {
			return;
		}

		const previousPendingCount = this.pendingPaths.size;

		for (const path of result.uploadedPaths) {
			this.pendingPaths.delete(path);
		}
		for (const path of result.downloadedPaths) {
			this.pendingPaths.delete(path);
		}
		for (const path of result.deletedPaths) {
			this.pendingPaths.delete(`delete:${path}`);
		}

		if (this.pendingPaths.size === previousPendingCount) {
			return;
		}

		if (this.pendingPaths.size === 0) {
			this.clearDebounceTimer();
		}
		this.updateState({ pendingChanges: this.pendingPaths.size });
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
			parallelDownloadAndSaveFiles: (paths: string[], result: SyncResult) =>
				this.parallelDownloadAndSaveFiles(paths, result),
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
			getLocalDeletes: () => this.getLocalDeletes(),
		};
	}

	private getPeriodicCheckWorkflowContext() {
		return {
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			getSyncIntervalSeconds: () => this.settings.syncInterval,
			getLastSeq: () => this.settings.lastSeq,
			getPendingPathCount: () => this.pendingPaths.size,
			getConsecutiveCheckFailures: () => this.consecutiveCheckFailures,
			setConsecutiveCheckFailures: (value: number) => {
				this.consecutiveCheckFailures = value;
			},
			getLastCheckAttempt: () => this.lastCheckAttempt,
			setLastCheckAttempt: (value: number) => {
				this.lastCheckAttempt = value;
			},
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
			deleteRemoteFile: async (path: string) => {
				await this.api.deleteFile(path);
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

	private async downloadAndSaveFile(path: string, result: SyncResult): Promise<void> {
		await transferDownloadAndSaveFile(this.getTransferContext(), path, result);
	}

	private async parallelDownloadAndSaveFiles(paths: string[], result: SyncResult): Promise<void> {
		await transferParallelDownloadAndSaveFiles(
			this.getTransferContext(),
			paths,
			result,
			DOWNLOAD_CONCURRENCY,
		);
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const result = await runSyncWorkflow(this.getSyncWorkflowContext(), progressCallback);
		this.clearSyncedPendingPaths(result);
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
		const result = await runInitialSyncWorkflow(this.getInitialSyncWorkflowContext(), progressCallback);
		this.clearSyncedPendingPaths(result);
		return result;
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const result = await runForceFullSyncWorkflow(this.getForceSyncWorkflowContext(), progressCallback);
		this.clearSyncedPendingPaths(result);
		return result;
	}

	destroy(): void {
		this.destroyed = true;
		this.abortController.abort();
		this.stopPeriodicSync();
		this.clearDebounceTimer();
		this.pendingPaths.clear();
	}
}
