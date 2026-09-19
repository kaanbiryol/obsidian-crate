import { findStartupPendingPaths } from './startup-pending';
import { SyncTimingRecorder } from './timings';
/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import { type Plugin, type TAbstractFile, type Vault } from 'obsidian';
import { SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import { MarkdownBaseCache } from './markdown-base-cache';
import { ConflictStore } from './conflict-store';
import { isConflictFile } from './conflict';
import { isHiddenPath, type VaultFile } from './file-discovery';
import { assertLocalSyncPath } from './local-path-safety';
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
import { AUTH_ERROR_MESSAGE, isAuthError, DOWNLOAD_CONCURRENCY, PREPARE_CONCURRENCY, UPLOAD_CONCURRENCY } from './engine-constants';
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
import { createEmptySyncResult, createSyncFailureResult } from './sync-result';
import { createPendingDiscard } from './pending-discard';
import { readLocalFileEntry } from './local-file-entry';
import { recordAppliedContent } from './applied-content';
import type { DiffApplyOutcome } from './transfer-types';
import type { UploadPreparedFilesOptions } from './transfer-upload';
import { mergeSyncResults } from './sync-result';
import { assertLocalFileAbsent } from './local-absence';
import { normalizeWorkerUrl } from './worker-url';
import { LocalContentVerifier } from './content-verifier';

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
	private timingRecorder = new SyncTimingRecorder();
	getTimings() { return { ...this.timingRecorder.snapshot(), requests: this.api.getRequestTimings?.() }; }
	private onStateChange: ((state: SyncState) => void) | null = null;
	private activeWork = new Set<Promise<unknown>>();
	private contentVerifier: LocalContentVerifier;
	private periodicCheckFailed = false;
	private onAutomaticSyncResult: ((result: SyncResult) => void | Promise<void>) | null = null;
	private prepareReminderScope?: () => Promise<void>;
	private rawEventRevisions = new Map<string, object>();
	private patternCache = new Map<string, RegExp>();
	private ignoredDirPrefixes: string[] = [];
	private syncActivityRevision = 0;
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
		this.localManifest = new LocalManifest(plugin.app, plugin.manifest, normalizeWorkerUrl(settings.workerUrl) || 'unconfigured');
		this.contentVerifier = new LocalContentVerifier({
			adapter: this.vault.adapter,
			path: `${plugin.manifest.dir}/content-verification.json`,
			authority: normalizeWorkerUrl(settings.workerUrl) || 'unconfigured',
		});
		this.markdownBaseCache = new MarkdownBaseCache(plugin.app, plugin.manifest);
		this.api.configureUploadJournal(this.localManifest, this.vault, this.markdownBaseCache);
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
			automaticSyncEnabled: () => this.settings.automaticSync,
			getSyncIntervalSeconds: () => this.settings.automaticSync ? this.settings.syncInterval : 0,
			getLastSeq: () => this.settings.lastSeq,
			getPendingPathCount: () => this.queueController.getPendingPathCount(),
			hasLocalFileChanges: async () => this.localManifest.uploadJournal.pending().length > 0 || await hasLocalFileChanges(
				this.vault,
				this.localManifest,
				this.shouldIgnore.bind(this),
				files => this.verifyContent(files),
			),
			checkForChanges: async (lastSeq: number) => {
				void this.retryReminderScope();
				return this.api.checkForChanges(lastSeq);
			},
			sync: async () => {
				const result = await this.sync();
				if (!this.lifecycle.isDestroyed) await this.onAutomaticSyncResult?.(result);
				return result;
			},
			onCheckSuccess: () => {
				if (this.periodicCheckFailed) this.updateState({ status: 'idle', lastError: null });
			},
			onCheckFailure: error => {
				if (this.lifecycle.isDestroyed || this.state.status === 'syncing') return;
				this.updateState({ status: 'error', lastError: isAuthError(error) ? AUTH_ERROR_MESSAGE : `Sync check failed: ${errorMessage(error)}` });
				this.periodicCheckFailed = true;
			},
		});
		this.api.setAbortSignal(this.lifecycle.abortSignal);
		this.queueController = new SyncQueueController({
			finishInitialSetup: () => this.contexts.finishInitialSetup(),
			automaticSyncEnabled: () => this.settings.automaticSync,
			recoverUploads: async () => {
				void this.retryReminderScope();
				await this.api.recoverUploads((current, total) => this.updateState({ work: { phase: 'recovering', current, total } }));
				this.updateState({ work: { phase: 'applying' } });
			},
			api: this.api,
			getLocalManifest: () => this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			shouldIgnore: this.shouldIgnore.bind(this),
			updateState: this.updateState.bind(this),
			isDestroyed: () => this.lifecycle.isDestroyed,
			currentStatus: () => this.state.status,
			prepareUploadFromPath: (path: string) => this.prepareUploadFromPath(path),
			assertLocalFileAbsent: (path: string) => assertLocalFileAbsent(this.vault, path),
			runConcurrent: this.runConcurrent.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
			getDebounceDelayMs: () => (this.settings.debounceDelay ?? 5) * 1000,
			uploadConcurrency: UPLOAD_CONCURRENCY,
			maxDebounceWaitMs: MAX_DEBOUNCE_WAIT_MS,
			reconcile: (queueKeys) => this.reconcileFromQueue(queueKeys),
			onFlushResult: (result) => this.onAutomaticSyncResult?.(result),
		});
		this.contexts = new SyncEngineContexts({
			prepareReminderScope: async () => { await this.prepareReminderScope?.(); },
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
			getLocalChanges: (onUnchanged) => this.getLocalChanges(onUnchanged),
			verifyContent: files => this.verifyContent(files),
			getLocalDeletes: () => this.getLocalDeletes(),
			incrementalSync: (progressCallback) => this.incrementalSync(progressCallback),
			parallelDownloadAndSaveFiles: (requests, result, onProcessed) =>
				this.parallelDownloadAndSaveFiles(requests, result, onProcessed),
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
		this.lifecycle.throwIfDestroyed();
		await this.conflictStore.load();
		this.lifecycle.throwIfDestroyed();
		logger.info('Engine initialized');
		this.plugin.app.workspace.onLayoutReady(() => {
			this.scheduleConflictRecovery();
			if (!this.settings.automaticSync) this.restoreStartupPendingChanges();
		});
		this.seedMarkdownBaseCacheInBackground();

		this.lifecycle.startPeriodicSync();
	}

	setStateChangeCallback(callback: (state: SyncState) => void): void {
		this.onStateChange = callback;
	}

	setAutomaticSyncResultCallback(callback: (result: SyncResult) => void | Promise<void>): void {
		this.onAutomaticSyncResult = callback;
	}

	updateSettings(settings: CrateSettings): void {
		this.patternCache.clear();
		this.settings = settings;
		this.ignoredDirPrefixes = this.getIgnoredDirPrefixes(settings);
		this.lifecycle.settingsChanged();
		this.queueController.settingsChanged();
	}

	setReminderScopePreparation(prepare?: () => Promise<void>): void {
		this.prepareReminderScope = prepare;
	}

	private async retryReminderScope(): Promise<void> {
		try {
			await this.prepareReminderScope?.();
		} catch (error) {
			if (!this.lifecycle.isDestroyed) logger.warn('Reminder settings will retry on the next sync:', errorMessage(error));
		}
	}

	getState(): SyncState {
		return { ...this.state };
	}

	getPendingPaths(): string[] {
		return this.queueController.getPendingPaths();
	}

    async syncSelected(keys: string[]): Promise<SyncResult> {
        this.assertPendingSelection(keys);
        return this.reconcileFromQueue([...new Set(keys)], true);
    }

    private assertPendingSelection(keys: string[]): void {
        this.lifecycle.throwIfDestroyed();
        if (!this.api.isConfigured()) throw new Error('Sync is not configured.');
        if (this.state.status === 'syncing') throw new Error('Wait for the current sync to finish.');
        if (this.localManifest.uploadJournal.pending().length > 0) throw new Error('Run Sync now to recover interrupted uploads before changing individual files.');
        const pending = new Set(this.getPendingPaths());
        if (!keys.length || keys.some(key => !pending.has(key))) throw new Error('Pending files changed. Review the current selection and try again.');
    }

    async createPendingDiscard(keys: string[]) {
        this.assertPendingSelection(keys);
        const review = await createPendingDiscard({
            vault: this.vault, api: this.api,
            backupRoot: `${this.plugin.manifest.dir}/discard-recovery`,
            verify: () => {
                this.lifecycle.throwIfDestroyed();
            },
            beforeBinaryReplace: async path => {
                // A crash between trash and recreation must not become a remote
                // deletion. With no baseline, the next sync retrieves the server copy.
                this.localManifest.removeEntry(path);
                await this.localManifest.save();
            },
            applied: async (path, remote, content) => {
                if (remote && content) await recordAppliedContent(this.contexts.transfer(), path, content, remote.revision);
                else this.localManifest.removeEntry(path);
                await this.localManifest.save();
                const revisions = this.queueController.snapshotPendingRevisions();
                const local = await readLocalFileEntry(this.vault, path);
                if ((local?.hash ?? null) === (remote?.hash ?? null)) {
                    const result = createEmptySyncResult();
                    result.settledPaths = [path, `delete:${path}`];
                    this.queueController.clearSyncedPendingPaths(result, revisions);
                }
            },
        }, keys);
        return { ...review, discard: async () => {
            this.assertPendingSelection(keys);
            this.updateState({ status: 'syncing' });
            return this.trackWork(async () => {
                try { return await review.discard(); }
                finally { if (!this.lifecycle.isDestroyed) this.updateState({ status: 'idle' }); }
            });
        } };
    }

	async runConflictResolution<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state.status === 'syncing') throw new Error('Wait for sync to finish before resolving this conflict.');
		this.lifecycle.throwIfDestroyed();
		this.updateState({ status: 'syncing' });
		return this.trackWork(async () => {
			try { return await operation(); }
			finally { if (!this.lifecycle.isDestroyed) this.updateState({ status: 'idle' }); }
		});
	}

	async markConflictResolved(path: string): Promise<void> {
		await this.conflictStore.markResolved(path);
		this.updateState({ conflictCount: this.conflictStore.getActiveConflicts().length });
	}

	getActiveConflicts(): ConflictRecord[] {
		return this.conflictStore.getActiveConflicts();
	}

	async hasUnsyncedLocalChanges(): Promise<boolean> {
		return hasLocalFileChanges(
			this.vault,
			this.localManifest,
			this.shouldIgnore.bind(this),
			files => this.verifyContent(files),
		);
	}

	async previewIgnoredRemoteFiles(): Promise<string[]> {
		const manifest = await this.api.getManifest();
		return Object.keys(manifest.files).filter(path => this.shouldIgnore(path)).sort();
	}

	async purgeIgnoredRemoteFiles(): Promise<{ deleted: string[]; errors: string[] }> {
		return this.trackWork(async () => {
			const manifest = await this.api.getManifest();
			const paths = Object.keys(manifest.files).filter(path => this.shouldIgnore(path)).sort();
			this.lifecycle.throwIfDestroyed();
			const result = await deleteFilesInBatches({
				batchDelete: (batchPaths, expectedHashes, expectedRevisions) =>
					this.retryWithBackoff(() => this.api.batchDelete(batchPaths, expectedHashes, expectedRevisions)),
			}, paths.map(path => ({ path, expectedHash: manifest.files[path]!.hash, expectedRevision: manifest.files[path]!.revision })));
			for (const path of result.deleted) this.localManifest.removeEntry(path);
			await this.localManifest.save();
			return {
				deleted: result.deleted,
				errors: result.errors.map(error => `${error.path}: ${error.error}`),
			};
		});
	}

	private updateState(updates: Partial<SyncState>): void {
		if (this.lifecycle?.isDestroyed) return;
		if (updates.status === 'syncing' && this.state.status !== 'syncing') {
			this.syncActivityRevision++;
			this.timingRecorder.start(); this.api.resetRequestTimings?.();
		}
		this.timingRecorder.change(updates.work);
		if (updates.status && updates.status !== 'syncing') this.timingRecorder.stop();
		if ('status' in updates || 'lastError' in updates) this.periodicCheckFailed = false;
		this.state = { ...this.state, ...updates };
		if (updates.status) this.state.work = updates.status === 'syncing' ? updates.work : undefined;
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
		const pluginDir = this.plugin.manifest.dir?.replace(/\/+$/, '');
		return [...new Set([
			...(pluginDir ? [`${pluginDir}/`] : []),
			...settings.ignorePatterns.filter(p => p.endsWith('/')),
			this.markdownBaseCache.getIgnoredPrefix(),
		])];
	}

	private restoreStartupPendingChanges(): void {
		if (this.lifecycle.isDestroyed || this.state.status === 'syncing') return;
		const revision = this.syncActivityRevision;
		void this.trackWork(async () => {
			try {
				const paths = await findStartupPendingPaths({
					vault: this.vault,
					baseline: this.localManifest.getManifest().files,
					shouldIgnore: path => this.shouldIgnore(path),
					throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
					runConcurrent: this.runConcurrent.bind(this),
				}, PREPARE_CONCURRENCY);
				if (revision === this.syncActivityRevision && !this.settings.automaticSync) {
					this.queueController.restorePendingPaths(paths);
				}
			} catch (error) {
				if (!this.isAbortError(error) && revision === this.syncActivityRevision) {
					this.updateState({ status: 'error', lastError: `Could not check local changes: ${errorMessage(error)}` });
				}
			}
		});
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

	async onRawFileChange(path: string): Promise<void> {
		const configDir = this.vault.configDir;
		if (!isHiddenPath(path) && !path.startsWith(`${configDir}/`)) return;
		if (this.lifecycle.isDestroyed || this.shouldIgnore(path)) return;
		const revision = {};
		this.rawEventRevisions.set(path, revision);
		try {
			assertLocalSyncPath(path);
			const stat = await this.vault.adapter.stat(path);
			if (this.lifecycle.isDestroyed || this.rawEventRevisions.get(path) !== revision || this.shouldIgnore(path)) return;
			if (stat?.type === 'file') this.queueController.onFileChange({ path });
			else if (!stat) this.queueController.onFileDelete({ path });
		} catch (error) {
			logger.warn('Failed to inspect changed configuration file:', errorMessage(error));
		} finally {
			if (this.rawEventRevisions.get(path) === revision) this.rawEventRevisions.delete(path);
		}
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
		if (!this.shouldIgnore(oldPath) && !this.shouldIgnore(file.path)) this.localManifest.recordRename(oldPath, file.path);
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

	private async getLocalChanges(onUnchanged?: (path: string) => void): Promise<{ path: string; hash: string }[]> {
		return planLocalChanges({
			...this.contexts.localDiffPlanner(),
			pendingPaths: new Set(this.queueController.getPendingPaths()),
		}, PREPARE_CONCURRENCY, onUnchanged);
	}

	private async parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void): Promise<void> {
		await transferParallelDownloadAndSaveFiles(
			this.contexts.transfer(),
			requests,
			result,
			DOWNLOAD_CONCURRENCY,
			onProcessed,
		);
	}

	private verifyContent(files: VaultFile[]): Promise<boolean> {
		return this.trackWork(() => this.contentVerifier.verify(this.vault, this.localManifest, files, this.lifecycle.abortSignal));
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.trackWork(async () => {
			void this.retryReminderScope();
			const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
			const workflow = this.contexts.syncWorkflow();
			this.contexts.clearPlannedContent();
            let result: SyncResult;
            try {
                result = await runSyncWorkflow(workflow, progressCallback);
            } finally {
                this.contexts.clearPlannedContent();
            }
			this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
			if (result.success) {
				this.pruneMarkdownBaseCacheInBackground();
			}
			return result;
		});
	}

	private async reconcileFromQueue(queueKeys: string[], selectedOnly = false): Promise<SyncResult> {
        if (this.state.status === 'syncing') return createSyncFailureResult('Sync already in progress');
		return this.trackWork(async () => {
			const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
			this.updateState({ status: 'syncing' });
			try {
				const result = await this.reconcilePaths(queueKeys, !selectedOnly);
				this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
				if (result.success) {
					if (!selectedOnly) await this.contexts.finishInitialSetup();
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
		});
	}

	private async reconcileVersionConflicts(paths: string[], result: SyncResult): Promise<void> {
		const reconciliation = await this.reconcilePaths(paths);
		mergeSyncResults(result, reconciliation);
	}

	private async reconcilePaths(queueKeys: string[], recover = true): Promise<SyncResult> {
		if (recover) await this.api.recoverUploads((current, total) => this.updateState({ work: { phase: 'recovering', current, total } }));
		this.lifecycle.throwIfDestroyed();
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
		return this.trackWork(async () => {
			void this.retryReminderScope();
			const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
			const result = await runInitialSyncWorkflow(this.contexts.initialSyncWorkflow(), progressCallback);
			this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
			if (result.success) {
				this.pruneMarkdownBaseCacheInBackground();
			}
			return result;
		});
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.trackWork(async () => {
			void this.retryReminderScope();
			const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
			const result = await runForceFullSyncWorkflow(this.contexts.forceSyncWorkflow(), progressCallback);
			this.queueController.clearSyncedPendingPaths(result, pendingRevisionSnapshot);
			if (result.success) {
				this.pruneMarkdownBaseCacheInBackground();
			}
			return result;
		});
	}

	private async trackWork<T>(operation: () => Promise<T>): Promise<T> {
		this.lifecycle.throwIfDestroyed();
		const task = operation();
		this.activeWork.add(task);
		try { return await task; } finally { this.activeWork.delete(task); }
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.activeWork, this.queueController.waitForIdle(), this.localManifest.close()]);
	}

	destroy(): void {
		if (this.conflictRecoveryTimer !== null) {
			clearTimeout(this.conflictRecoveryTimer);
			this.conflictRecoveryTimer = null;
		}
		this.lifecycle.destroy();
		this.queueController.destroy();
		void this.localManifest.close();
	}
}
