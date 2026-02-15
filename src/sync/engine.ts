/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import type { Plugin, TAbstractFile, Vault } from 'obsidian';
import { HttpError, SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import { computeHash } from './hasher';
import { isConflictFile } from './conflict';
import { getAllVaultFiles } from './file-discovery';
import type { VaultFile } from './file-discovery';
import {
	onFileChange as queueOnFileChange,
	onFileDelete as queueOnFileDelete,
	onFileRename as queueOnFileRename,
	debouncedSync as runDebouncedQueueSync,
	processPendingChanges as flushPendingQueueChanges,
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
import { acquireSyncLock } from './sync-guards';
import {
	createEmptySyncResult,
	finalizeSyncResult,
	getSyncResultError,
} from './sync-result';
import { createLogger } from '../logger';
import type {
	SyncState,
	SyncResult,
	FileDiff,
	PreparedUpload,
	FileEntry,
	CrateSettings,
} from '../types';
import { DEBOUNCE_DELAY_MS, MAX_DEBOUNCE_WAIT_MS } from '../types';

const logger = createLogger('SyncEngine');
const UPLOAD_CONCURRENCY = 5;
const DOWNLOAD_CONCURRENCY = 5;
const FORCE_SYNC_CONCURRENCY = 2;
const PREPARE_CONCURRENCY = 5;
const INITIAL_SYNC_PIPELINE_CHUNK_FILES = 120;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

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
	private syncInterval: ReturnType<typeof setInterval> | null = null;
	private onStateChange: ((state: SyncState) => void) | null = null;
	private patternCache = new Map<string, RegExp>();
	private ignoredDirPrefixes: string[] = [];
	private destroyed = false;
	private abortController = new AbortController();

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
		this.api.setAbortSignal(this.abortController.signal);
		this.state = {
			status: 'idle',
			lastSync: settings.lastSync,
			lastError: null,
			pendingChanges: 0,
		};
	}

	/**
	 * Initialize the sync engine
	 */
	async initialize(): Promise<void> {
		await this.localManifest.load();
		logger.info('Engine initialized');

		// Set up periodic sync if enabled
		if (this.settings.syncInterval > 0) {
			this.startPeriodicSync();
		}
	}

	/**
	 * Set state change callback
	 */
	setStateChangeCallback(callback: (state: SyncState) => void): void {
		this.onStateChange = callback;
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: CrateSettings): void {
		this.patternCache.clear();
		this.settings = settings;
		this.ignoredDirPrefixes = settings.ignorePatterns.filter(p => p.endsWith('/'));

		// Restart periodic sync with new interval
		this.stopPeriodicSync();
		if (settings.syncInterval > 0) {
			this.startPeriodicSync();
		}
	}

	/**
	 * Get current sync state
	 */
	getState(): SyncState {
		return { ...this.state };
	}

	/**
	 * Start periodic sync
	 */
	private startPeriodicSync(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
		}
		this.syncInterval = setInterval(
			() => this.periodicCheck(),
			this.settings.syncInterval * 1000
		);
	}

	/**
	 * Lightweight periodic check — only triggers full sync if remote has changes
	 */
	private async periodicCheck(): Promise<void> {
		if (this.state.status === 'syncing') return;
		if (!this.api.isConfigured()) return;

		try {
			const { hasChanges } = await this.api.checkForChanges(this.settings.lastSeq);

			if (!hasChanges && this.pendingPaths.size === 0) {
				logger.debug('Periodic check: no changes');
				return;
			}

			logger.info('Periodic check: changes detected, running sync');
			await this.sync();
		} catch (error) {
			logger.warn('Periodic check failed:', error instanceof Error ? error.message : 'Unknown error');
		}
	}

	/**
	 * Stop periodic sync
	 */
	private stopPeriodicSync(): void {
		if (this.syncInterval) {
			clearInterval(this.syncInterval);
			this.syncInterval = null;
		}
	}

	/**
	 * Update and notify state change
	 */
	private updateState(updates: Partial<SyncState>): void {
		this.state = { ...this.state, ...updates };
		this.onStateChange?.(this.state);
	}

	/**
	 * Check if path should be ignored
	 */
	private shouldIgnore(path: string): boolean {
		// Always ignore conflict files to prevent loops
		if (isConflictFile(path)) {
			return true;
		}

		// Fast-path: check pre-computed directory prefixes with startsWith
		for (const prefix of this.ignoredDirPrefixes) {
			if (path.startsWith(prefix) || path === prefix.slice(0, -1)) {
				return true;
			}
		}

		for (const pattern of this.settings.ignorePatterns) {
			// Skip directory patterns already handled above
			if (pattern.endsWith('/')) continue;
			if (this.matchPattern(path, pattern)) {
					return true;
			}
		}
		return false;
	}

	/**
	 * Simple glob pattern matching
	 * Trailing-slash patterns (e.g. `.trash/`) match everything under that prefix.
	 */
	private matchPattern(path: string, pattern: string): boolean {
		// Trailing-slash pattern: match the prefix and anything beneath it
		if (pattern.endsWith('/')) {
			return path.startsWith(pattern) || path === pattern.slice(0, -1);
		}

		let regex = this.patternCache.get(pattern);
		if (!regex) {
			const regexPattern = Array.from(pattern).map(char => {
				if (char === '*') return '.*';
				if (char === '?') return '.';
				return char.replace(/[\\^$+.|(){}\[\]]/g, '\\$&');
			}).join('');
			try {
				regex = new RegExp(`^${regexPattern}$`);
			} catch (error) {
				logger.warn(`Invalid ignore pattern "${pattern}":`, error instanceof Error ? error.message : 'Unknown error');
				// Never match on invalid patterns to avoid sync crashes.
				regex = /^$/;
			}
			this.patternCache.set(pattern, regex);
		}
		return regex.test(path);
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

	/**
	 * Handle file change (create, modify)
	 */
	onFileChange(file: TAbstractFile): void {
		queueOnFileChange(this.getQueueEventContext(), file);
	}

	/**
	 * Handle file deletion
	 */
	onFileDelete(file: TAbstractFile): void {
		queueOnFileDelete(this.getQueueEventContext(), file);
	}

	/**
	 * Handle file rename
	 */
	onFileRename(file: TAbstractFile, oldPath: string): void {
		queueOnFileRename(this.getQueueEventContext(), file, oldPath);
	}

	/**
	 * Debounced sync trigger
	 */
	private debouncedSync(): void {
		runDebouncedQueueSync(this.getQueueDebounceContext(), DEBOUNCE_DELAY_MS, MAX_DEBOUNCE_WAIT_MS);
	}

	/**
	 * Process pending file changes
	 */
	private async processPendingChanges(): Promise<void> {
		await flushPendingQueueChanges(this.getQueueFlushContext(), UPLOAD_CONCURRENCY);
	}

	private async prepareUploadFromPath(path: string): Promise<PreparedUpload | null> {
		return prepareTransferUploadFromPath(this.getTransferContext(), path);
	}

	/**
	 * Run tasks with limited concurrency
	 */
	private async runConcurrent<T>(
		tasks: (() => Promise<T>)[],
		concurrency: number
	): Promise<T[]> {
		const results: T[] = [];
		let index = 0;
		const destroyed = () => this.destroyed;
		async function next(): Promise<void> {
			while (index < tasks.length) {
				if (destroyed()) break;
				const i = index++;
				results[i] = await tasks[i]!();
			}
		}
		await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => next()));
		return results;
	}

	/**
	 * Retry an async operation with exponential backoff
	 */
	private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await fn();
			} catch (error) {
				if (this.isAbortError(error) || this.destroyed) throw error;
				if (attempt === MAX_RETRIES) throw error;
				let delay: number;
				if (error instanceof HttpError && error.retryAfter !== null) {
					delay = error.retryAfter;
				} else {
					delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
				}
				logger.warn(`Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms`);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
		throw new Error('Unreachable');
	}

	private async getModifiedIso(path: string, fallbackMtime?: number): Promise<string> {
		const stat = await this.vault.adapter.stat(path);
		return new Date(stat?.mtime ?? fallbackMtime ?? Date.now()).toISOString();
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

	private async getLocalDeletes(): Promise<string[]> {
		return planLocalDeletes(this.getLocalDiffPlannerContext(), PREPARE_CONCURRENCY);
	}

	/**
	 * Incremental sync using changelog.
	 * Returns SyncResult on success, or null to fall back to full sync.
	 */
	private async incrementalSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult | null> {
		return runIncrementalSync(this.getIncrementalPlannerContext(), {
			uploadConcurrency: UPLOAD_CONCURRENCY,
			progressCallback,
		});
	}

	/**
	 * Get locally modified files since last sync
	 */
	private async getLocalChanges(): Promise<{ path: string; hash: string }[]> {
		return planLocalChanges(this.getLocalDiffPlannerContext(), PREPARE_CONCURRENCY);
	}

	/**
	 * Download a file from remote and save it locally
	 */
	private async downloadAndSaveFile(path: string, result: SyncResult): Promise<void> {
		await transferDownloadAndSaveFile(this.getTransferContext(), path, result);
	}

	/**
	 * Download files in parallel using individual binary requests
	 */
	private async parallelDownloadAndSaveFiles(paths: string[], result: SyncResult): Promise<void> {
		await transferParallelDownloadAndSaveFiles(
			this.getTransferContext(),
			paths,
			result,
			DOWNLOAD_CONCURRENCY,
		);
	}

	/**
	 * Full sync - compare manifests and sync all differences
	 */
	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const guardResult = acquireSyncLock(
			{ isConfigured: this.api.isConfigured(), status: this.state.status },
			() => this.updateState({ status: 'syncing' }),
		);
		if (guardResult) return guardResult;

		logger.info('Sync started');

		// Try incremental sync first
		const incrementalResult = await this.incrementalSync(progressCallback);
		if (incrementalResult) {
			if (incrementalResult.success) {
				const lastSync = new Date().toISOString();
				this.updateState({ status: 'idle', lastSync, lastError: null });
				this.settings.lastSync = lastSync;
			} else {
				const lastError = getSyncResultError(incrementalResult, 'Incremental sync completed with errors');
				this.updateState({ status: 'error', lastError });
			}
			return incrementalResult;
		}

		logger.info('Running full sync');

		const result: SyncResult = createEmptySyncResult();

		try {
			this.throwIfDestroyed();
			const remoteManifest = await this.api.getManifest();
			const plan = await createFullSyncPlan(
				this.getFullSyncPlannerContext(),
				remoteManifest.files,
				PREPARE_CONCURRENCY,
			);

			const {
				localFiles,
				diffs,
				uploadDiffs,
				downloadDiffs,
				remainingDiffs,
				errors,
			} = plan;
			result.errors.push(...errors);

			const conflictDiffs = diffs.filter(d => d.action === 'conflict');
			const deleteDiffs = diffs.filter(d => d.action === 'delete');
			logger.info(`Full sync diffs: ${uploadDiffs.length} upload, ${downloadDiffs.length} download, ${conflictDiffs.length} conflict, ${deleteDiffs.length} delete`);

			const total = diffs.length;
			let current = 0;

			// Run upload diffs concurrently
			if (uploadDiffs.length > 0) {
				const uploadTasks = uploadDiffs.map(diff => async () => {
					try {
						await this.processDiff(diff, localFiles, result);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Unknown error';
						result.errors.push(`${diff.path}: ${errorMessage}`);
					}
					current++;
					progressCallback?.(current, total);
				});
				await this.runConcurrent(uploadTasks, UPLOAD_CONCURRENCY);
			}

			this.throwIfDestroyed();

			// Download files in parallel
			if (downloadDiffs.length > 0) {
				await this.parallelDownloadAndSaveFiles(
					downloadDiffs.map(d => d.path),
					result,
				);
				// Update localFiles record for downloaded files
				for (const diff of downloadDiffs) {
					try {
						const content = await this.vault.adapter.readBinary(diff.path);
						const hash = await computeHash(content);
						localFiles[diff.path] = {
							hash,
							size: content.byteLength,
							modified: await this.getModifiedIso(diff.path),
						};
					} catch {
						// File may have failed to download; error already recorded
					}
				}
				current += downloadDiffs.length;
				progressCallback?.(current, total);
			}

			this.throwIfDestroyed();

			// Process conflict and delete diffs sequentially
			for (const diff of remainingDiffs) {
				if (this.destroyed) break;
				try {
					await this.processDiff(diff, localFiles, result);
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`${diff.path}: ${errorMessage}`);
				}
				current++;
				progressCallback?.(current, total);
			}

			// Update local manifest
			for (const [path, entry] of Object.entries(localFiles)) {
				this.localManifest.setEntry(path, entry);
			}
			await this.localManifest.save();

			const lastSync = new Date().toISOString();
			this.updateState({
				status: 'idle',
				lastSync,
				lastError: result.errors.length > 0 ? result.errors[0] ?? null : null,
			});

			// Save last sync time and seq cursor to settings
			this.settings.lastSync = lastSync;
			if (
				result.errors.length === 0 &&
				remoteManifest.lastSeq !== undefined &&
				remoteManifest.lastSeq > 0
			) {
				this.settings.lastSeq = remoteManifest.lastSeq;
			}

			logger.info(`Full sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.conflicts.length} conflicts`);
		} catch (error) {
			if (this.isAbortError(error)) {
				logger.info('Full sync aborted');
			} else {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				result.errors.push(errorMessage);
				logger.error('Full sync failed:', errorMessage);
				this.updateState({
					status: 'error',
					lastError: errorMessage,
				});
			}
		}

		finalizeSyncResult(result);
		return result;
	}

	/**
	 * Process a single diff
	 */
	private async processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<void> {
		await transferProcessDiff(this.getTransferContext(), diff, localFiles, result);
	}

	/**
	 * Prepare uploads with bounded concurrency to reduce initial sync wall time.
	 */
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

	/**
	 * Upload prepared files as parallel individual binary uploads
	 */
	private async uploadPreparedFiles(
		prepared: PreparedUpload[],
		result: SyncResult,
		options: { concurrency: number; retry: boolean },
	): Promise<void> {
		await transferUploadPreparedFiles(this.getTransferContext(), prepared, result, options);
	}

	private createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][] {
		return transferCreateVaultFileChunks(files, chunkSize);
	}

	/**
	 * Initial sync - upload all local files
	 */
	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const guardResult = acquireSyncLock(
			{ isConfigured: this.api.isConfigured(), status: this.state.status },
			() => this.updateState({ status: 'syncing' }),
		);
		if (guardResult) return guardResult;

		const result: SyncResult = createEmptySyncResult();

		try {
			const files = await getAllVaultFiles(this.vault, this.shouldIgnore.bind(this));
			logger.info(`Initial sync started with ${files.length} files`);
			const total = files.length;
			let preparedCount = 0;
			let uploadCandidates = 0;

			const chunks = this.createVaultFileChunks(files, INITIAL_SYNC_PIPELINE_CHUNK_FILES);
			const prepareChunk = (chunk: VaultFile[]) => this.prepareUploadsFromVaultFiles(chunk, () => {
				preparedCount++;
				progressCallback?.(preparedCount, total);
			});

			let chunkIndex = 0;
			let currentPrepare = chunks.length > 0 ? prepareChunk(chunks[0]!) : null;
			while (currentPrepare) {
				const preparedChunk = await currentPrepare;
				this.throwIfDestroyed();
				uploadCandidates += preparedChunk.length;

				chunkIndex++;
				const nextChunk = chunkIndex < chunks.length ? chunks[chunkIndex]! : null;
				const nextPrepare = nextChunk ? prepareChunk(nextChunk) : null;

				if (preparedChunk.length > 0) {
					await this.uploadPreparedFiles(preparedChunk, result, {
						concurrency: UPLOAD_CONCURRENCY,
						retry: true,
					});
				}

				currentPrepare = nextPrepare;
			}

			logger.info(`Prepared ${uploadCandidates}/${total} files for upload (${total - uploadCandidates} unchanged)`);

			await this.localManifest.save();

			logger.info(`Initial sync completed: ${result.uploaded} uploaded`);
			if (finalizeSyncResult(result)) {
				const lastSync = new Date().toISOString();
				this.updateState({
					status: 'idle',
					lastSync,
					lastError: null,
				});
				this.settings.lastSync = lastSync;
			} else {
				this.updateState({
					status: 'error',
					lastError: getSyncResultError(result, 'Initial sync completed with errors'),
				});
			}
		} catch (error) {
			if (this.isAbortError(error)) {
				logger.info('Initial sync aborted');
			} else {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				result.errors.push(errorMessage);
				this.updateState({
					status: 'error',
					lastError: errorMessage,
				});
			}
		}

		finalizeSyncResult(result);
		return result;
	}

	/**
	 * Force full sync - overwrite all remote files with local vault state
	 * Clears local manifest so all files are uploaded regardless of hash,
	 * and deletes remote-only files.
	 */
	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const guardResult = acquireSyncLock(
			{ isConfigured: this.api.isConfigured(), status: this.state.status },
			() => this.updateState({ status: 'syncing' }),
		);
		if (guardResult) return guardResult;

		const result: SyncResult = createEmptySyncResult();

		try {
			// Fetch remote manifest to find remote-only files
			const remoteManifest = await this.api.getManifest();
			const remotePaths = new Set(Object.keys(remoteManifest.files));

			// Get local files
			const files = await getAllVaultFiles(this.vault, this.shouldIgnore.bind(this));
			const localPaths = new Set(files.map(f => f.path));

			// Find remote-only paths (to be deleted), excluding ignored paths.
			const remoteOnlyPaths = [...remotePaths].filter(
				p => !localPaths.has(p) && !this.shouldIgnore(p),
			);

			const total = files.length + remoteOnlyPaths.length;
			let current = 0;

			// Clear local manifest so prepareUpload won't skip any file
			this.localManifest.clear();

			// First pass: prepare uploads with bounded concurrency (local I/O)
			const prepared = await this.prepareUploadsFromVaultFiles(files, completed => {
				current = completed;
				progressCallback?.(current, total);
			});

			this.throwIfDestroyed();

			// Second pass: upload individually with retry
			await this.uploadPreparedFiles(prepared, result, {
				concurrency: FORCE_SYNC_CONCURRENCY,
				retry: true,
			});

			this.throwIfDestroyed();

			// Delete remote-only files
			for (const path of remoteOnlyPaths) {
				if (this.destroyed) break;
				try {
					await this.api.deleteFile(path);
					this.localManifest.removeEntry(path);
					result.deleted++;
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'Unknown error';
					result.errors.push(`delete ${path}: ${errorMessage}`);
				}
				current++;
				progressCallback?.(current, total);
			}

			await this.localManifest.save();

			const lastSync = new Date().toISOString();
			logger.info(`Force full sync completed: ${result.uploaded} uploaded, ${result.deleted} remote-only deleted`);
			if (finalizeSyncResult(result)) {
				this.updateState({
					status: 'idle',
					lastSync,
					lastError: null,
				});
				this.settings.lastSync = lastSync;
			} else {
				this.updateState({
					status: 'error',
					lastError: getSyncResultError(result, 'Force full sync completed with errors'),
				});
			}
		} catch (error) {
			if (this.isAbortError(error)) {
				logger.info('Force full sync aborted');
			} else {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				result.errors.push(errorMessage);
				logger.error('Force full sync failed:', errorMessage);
				this.updateState({
					status: 'error',
					lastError: errorMessage,
				});
			}
		}

		finalizeSyncResult(result);
		return result;
	}

	/**
	 * Cleanup on unload
	 */
	destroy(): void {
		this.destroyed = true;
		this.abortController.abort();
		this.stopPeriodicSync();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.maxWaitStart = null;
		this.pendingPaths.clear();
	}
}
