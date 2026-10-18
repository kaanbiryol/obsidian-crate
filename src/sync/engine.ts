import { pendingChangeKey } from './pending-change';
import type { RemoteFileVersion } from '../protocol/sync-types';
import type { EngineFileOperations } from './engine-file-operations';
import { createEngineHistory } from './engine-history';
import { createEnginePendingChanges } from './engine-pending-changes';
import { getSyncIssues, recordSyncError, syncErrorIssues } from './issues';
import { findStartupPendingPaths } from './startup-pending';
import { SyncTimingRecorder } from './timings';
/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import { TFolder, type Plugin, type TAbstractFile, type Vault } from 'obsidian';
import { SyncApiClient } from './api';
import { LocalManifest } from './manifest';
import { MarkdownBaseCache } from './markdown-base-cache';
import { ConflictStore } from './conflict-store';
import { isConflictFile } from './conflict';
import { isHiddenPath, type VaultFile } from './file-discovery';
import { assertLocalSyncPath } from './local-path-safety';
import { SyncQueueController } from './queue-controller';
import { createAbortError, isAbortError as isSyncAbortError } from './abort';
import { createLogger, errorMessage } from '../plugin/logger';
import type { SyncState, SyncResult, ConflictRecord } from './types';
import type { FileEntry } from '../protocol/sync-types';
import { createPathRecord } from '../protocol/path-record';
import type { CrateSettings } from '../plugin/settings-types';
import { MAX_DEBOUNCE_WAIT_MS } from '../plugin/settings-types';
import { AUTH_ERROR_MESSAGE, isAuthError, PREPARE_CONCURRENCY } from './engine-constants';
import {
	type IgnoreMatcherContext,
	shouldIgnoreConfiguredPath,
	shouldIgnoreSyncPath,
} from './engine-ignore';
import { hasLocalFileChanges } from './local-file-changes';
import { createExclusionCleanupReview } from './engine-exclusion-cleanup';
import {
	runForceFullSyncWorkflow,
	runInitialSyncWorkflow,
	runSyncWorkflow,
} from './engine-workflows';
import { SyncEngineContexts } from './engine-contexts';
import { SyncEngineLifecycle } from './engine-lifecycle';
import { reconcileQueuePaths } from './reconcile-paths';
import { uploadFullSyncPlan } from './engine-full-sync-upload';
import { cancelSyncResult, createEmptySyncResult, createSyncFailureResult, finalizeSyncResult } from './sync-result';
import { mergeSyncResults } from './sync-result';
import { getCheckpointAuthority } from './worker-url';
import { LocalContentVerifier } from './content-verifier';
import { updateSyncProgress } from '../plugin/settings-persistence';
import { verifyUnchangedPendingPaths } from './pending-verification';

const logger = createLogger('SyncEngine');

export class SyncEngine {
	private plugin: Plugin;
	private vault: Vault;
	private api: SyncApiClient;
	private readonly files: EngineFileOperations;
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
	private shutdownTask: Promise<void> | null = null;
	private contentVerifier: LocalContentVerifier;
	private periodicCheckFailed = false;
	private onAutomaticSyncResult: ((result: SyncResult) => void | Promise<void>) | null = null;
	private prepareReminderScope?: () => Promise<void>;
	private rawEventRevisions = new Map<string, object>();
	private rawVerificationTask: Promise<unknown> = Promise.resolve();
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
		this.localManifest = new LocalManifest(plugin.app, plugin.manifest, getCheckpointAuthority(settings) || 'unconfigured');
		this.contentVerifier = new LocalContentVerifier({
			adapter: this.vault.adapter,
			path: `${plugin.manifest.dir}/content-verification.json`,
			authority: getCheckpointAuthority(settings) || 'unconfigured',
		});
		this.markdownBaseCache = new MarkdownBaseCache(plugin.app, plugin.manifest);
		this.files = this.api.createFileOperations(this.localManifest, this.vault, this.markdownBaseCache);
		const latestAttempt = settings.syncHistory[0];
		const lastError = latestAttempt && !latestAttempt.success
			? latestAttempt.errors?.[0] || 'The last sync failed. Open sync activity for details, then retry.'
			: null;
		this.state = {
			status: lastError ? 'error' : 'idle',
			lastSync: settings.lastSync,
			lastError,
			...(lastError && latestAttempt ? { lastIssues: getSyncIssues(latestAttempt) } : {}),
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
			hasLocalFileChanges: async () => this.localManifest.uploadJournal.pending().length > 0 || await this.hasUnsyncedLocalChanges(),
			verifyLocalContent: () => this.verifyTrackedContent(),
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
				this.updateState({ status: 'error', lastError: isAuthError(error) ? AUTH_ERROR_MESSAGE : `Sync check failed: ${errorMessage(error)}`,
					...(!isAuthError(error) ? { lastIssues: syncErrorIssues(error) } : {}),
				});
				this.periodicCheckFailed = true;
			},
		});
		this.api.setAbortSignal(this.lifecycle.abortSignal);
		this.queueController = new SyncQueueController({
			finishInitialSetup: () => this.contexts.finishInitialSetup(),
			uploadPreparedFiles: (...args) => this.contexts.uploadPreparedFiles(...args),
			deleteRemoteFiles: (...args) => this.contexts.deleteRemoteFiles(...args),
			automaticSyncEnabled: () => this.settings.automaticSync,
			recoverUploads: async () => {
				void this.retryReminderScope();
				await this.files.recoverUploads((current, total) => this.updateState({ work: { phase: 'recovering', current, total } }));
				this.updateState({ work: { phase: 'applying' } });
			},
			api: {
				isConfigured: () => this.api.isConfigured(),
			},
			getLocalManifest: () => this.localManifest,
			shouldIgnore: this.shouldIgnore.bind(this),
			updateState: this.updateState.bind(this),
			isDestroyed: () => this.lifecycle.isDestroyed,
			currentStatus: () => this.state.status,
			verifyPendingPaths: (keys, isCurrent) => this.verifyPendingPaths(keys, isCurrent),
			prepareUploadFromPath: (path: string) => this.contexts.prepareUploadFromPath(path),
			getDebounceDelayMs: () => (this.settings.debounceDelay ?? 5) * 1000,
			maxDebounceWaitMs: MAX_DEBOUNCE_WAIT_MS,
			reconcile: (queueKeys) => this.reconcileFromQueue(queueKeys),
			onFlushResult: (result) => this.onAutomaticSyncResult?.(result),
		});
		this.contexts = new SyncEngineContexts({
			prepareReminderScope: async () => { await this.prepareReminderScope?.(); },
			vault: this.vault,
			fileManager: this.plugin.app.fileManager,
			api: this.api,
			files: this.files,
			getLocalManifest: () => this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			conflictStore: this.conflictStore,
			getSettings: () => this.settings,
			getStatus: () => this.state.status,
			shouldIgnore: this.shouldIgnore.bind(this),
			runConcurrent: this.runConcurrent.bind(this),
			retryWithBackoff: this.retryWithBackoff.bind(this),
			getModifiedIso: this.getModifiedIso.bind(this),
			getPendingPaths: () => this.queueController.getPendingPaths(),
			verifyContent: files => this.verifyContent(files),
			reconcileVersionConflicts: (paths, result) => this.reconcileVersionConflicts(paths, result),
			updateState: this.updateState.bind(this),
			isAbortError: this.isAbortError.bind(this),
			throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
		});
	}

	getRequestDiagnostics() {
		return { ...this.api.getRequestDiagnostics(), uploads: this.files.getUploadDiagnostics() };
	}

	restoreFileVersion(version: RemoteFileVersion): Promise<void> {
		return this.trackWork(() => this.files.restoreFileVersion(version));
	}

	getPendingRestores() { return this.files.getPendingRestores(); }

	finishRestore(storageKey: string): Promise<void> {
		return this.trackWork(() => this.files.finishRestore(storageKey));
	}

	async initialize(): Promise<void> {
		this.updateState({ initializing: true });
		await this.localManifest.load();
		try { await this.history().prune(this.settings.syncHistory.flatMap(entry => entry.historyCheckpoint ? [entry.historyCheckpoint] : [])); }
		catch (error) { logger.warn('Could not prune old history checkpoints:', errorMessage(error)); }
		this.lifecycle.throwIfDestroyed();
		await this.conflictStore.load();
		this.lifecycle.throwIfDestroyed();
		logger.info('Engine initialized');
		this.plugin.app.workspace.onLayoutReady(() => {
			this.scheduleConflictRecovery();
			if (!this.settings.automaticSync) this.restoreStartupPendingChanges();
			else this.updateState({ initializing: false });
		});
		this.seedMarkdownBaseCacheInBackground();

		this.lifecycle.startPeriodicSync();
		if (this.settings.automaticSync) this.updateState({ initializing: false });
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

    private pendingChanges() {
        return createEnginePendingChanges({
            vault: this.vault, api: this.api, manifest: this.localManifest,
            cache: this.markdownBaseCache, queue: this.queueController,
            backupRoot: `${this.plugin.manifest.dir}/discard-recovery`,
            assertActive: () => this.lifecycle.throwIfDestroyed(),
            isDestroyed: () => this.lifecycle.isDestroyed,
            beforeBinaryReplace: path => this.prepareRecoverableReplacement(path),
        });
    }

    async loadPendingDiff(path: string, deleted: boolean) {
        return this.pendingChanges().loadDiff(path, deleted);
    }

	getPendingPaths(): string[] {
		return this.queueController.getPendingPaths();
	}

	getPendingChangeCount(): number {
		return this.queueController.getPendingChangeCount();
	}

    private history() {
        return createEngineHistory({
            vault: this.vault, api: this.api, pluginDir: `${this.plugin.manifest.dir}`,
            getSettings: () => this.settings, getManifest: () => this.localManifest.getManifest(),
            shouldIgnore: path => this.shouldIgnore(path),
            assertActive: () => this.lifecycle.throwIfDestroyed(),
            hasPendingMutations: () => Boolean(this.getActiveConflicts().length
                || this.localManifest.uploadJournal.pending().length || this.files.getPendingRestores().length),
            canCheckpoint: () => !this.lifecycle.isDestroyed && this.state.status !== 'syncing',
            runExclusive: operation => this.runExclusiveOperation(operation),
            applied: (path, removed) => this.queueController.restorePendingPaths([pendingChangeKey(removed ? 'delete' : 'upload', path)]),
        });
    }

    async saveSharedHistoryCheckpoint() { return this.trackWork(() => this.history().saveShared()); }
    trackedFileCount(): number { return this.localManifest.getAllPaths().length; }

    async saveHistoryCheckpoint(): Promise<string | undefined> { return this.trackWork(() => this.history().saveLocal()); }

    async loadHistoryComparison(checkpoint: string, shared = false) {
        return this.history().compare(checkpoint, shared);
    }

    async createHistoryRestore(checkpoint: string, beforeApply: () => Promise<void>, shared = false) {
        return this.history().prepareRestore(checkpoint, beforeApply, shared);
    }

    private async runExclusiveOperation<T>(operation: () => Promise<T>, busyMessage = 'Wait for sync to finish, then try again.'): Promise<T> {
        this.lifecycle.throwIfDestroyed();
        if (this.state.status === 'syncing') throw new Error(busyMessage);
        this.updateState({ status: 'syncing' });
        return this.trackWork(async () => {
            try { return await operation(); }
            finally { if (!this.lifecycle.isDestroyed) this.updateState({ status: 'idle' }); }
        });
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
        const review = await this.pendingChanges().prepareDiscard(keys);
        return { ...review, discard: async () => {
            this.assertPendingSelection(keys);
            return this.runExclusiveOperation(() => review.discard());
        } };
    }

	async runConflictResolution<T>(operation: () => Promise<T>): Promise<T> {
		return this.runExclusiveOperation(operation, 'Wait for sync to finish before resolving this conflict.');
	}

	/** Called within an exclusive recovery operation, before removing local bytes.
	 * A crash between trash and creation must not publish a remote deletion. */
	async prepareRecoverableReplacement(path: string): Promise<void> {
		this.lifecycle.throwIfDestroyed();
		this.localManifest.removeEntry(path);
		await this.localManifest.save();
		this.lifecycle.throwIfDestroyed();
	}

	async markConflictResolved(path: string): Promise<void> {
		await this.conflictStore.markResolved(path);
		this.updateState({ conflictCount: this.conflictStore.getActiveConflicts().length });
	}

	/** Preserve the user's keep-local intent without accepting a newer server edit.
	 * Publication remains in the ordinary durable upload/CAS pipeline. */
	async acceptIncomingConflictBaseline(record: ConflictRecord): Promise<void> {
		if (record.copySide !== 'remote') return;
		this.lifecycle.throwIfDestroyed();
		const remote = (await this.api.getFileMetadata([record.originalPath])).files[record.originalPath];
		if (!record.remoteHash || !remote || remote.hash !== record.remoteHash) {
			throw new Error('The server file changed. Sync again and review the latest incoming copy. Both versions were kept.');
		}
		this.lifecycle.throwIfDestroyed();
		this.localManifest.setEntry(record.originalPath, { ...remote, modified: 'unverified' });
		await this.localManifest.save();
		this.lifecycle.throwIfDestroyed();
		this.queueController.restorePendingPaths([pendingChangeKey('upload', record.originalPath)]);
	}

	getActiveConflicts(): ConflictRecord[] {
		return this.conflictStore.getActiveConflicts();
	}

	async hasUnsyncedLocalChanges(): Promise<boolean> {
		return this.trackWork(() => hasLocalFileChanges(
			this.vault,
			this.localManifest,
			this.shouldIgnore.bind(this),
			files => this.verifyContent(files),
			() => this.lifecycle.throwIfDestroyed(),
		));
	}

	async createExclusionCleanupReview() {
		return createExclusionCleanupReview({
			getManifest: () => this.api.getManifest(),
			getIgnorePatterns: () => this.settings.ignorePatterns,
			shouldIgnore: path => this.shouldIgnore(path),
			assertActive: () => this.lifecycle.throwIfDestroyed(),
			runExclusive: operation => this.runExclusiveOperation(operation),
			retryWithBackoff: operation => this.retryWithBackoff(operation),
			batchDelete: (...args) => this.files.batchDelete(...args),
			manifest: this.localManifest,
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
		if (updates.status && updates.status !== 'syncing') this.queueController.recheckPendingPaths();
		if ('lastError' in updates && !updates.lastIssues) this.state.lastIssues = undefined;
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
		if (this.lifecycle.isDestroyed) return;
		if (this.state.status === 'syncing') {
			this.updateState({ initializing: false });
			return;
		}
		const revision = this.syncActivityRevision;
		void this.trackWork(async () => {
			try {
				const paths = await findStartupPendingPaths({
					vault: this.vault,
					baseline: this.localManifest.getManifest().files,
					shouldIgnore: path => this.shouldIgnore(path),
					throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
					verifyContent: files => this.verifyContent(files),
					runConcurrent: this.runConcurrent.bind(this),
				}, PREPARE_CONCURRENCY);
				if (revision === this.syncActivityRevision && !this.settings.automaticSync) {
					this.queueController.restorePendingPaths(paths);
				}
			} catch (error) {
				if (!this.isAbortError(error) && revision === this.syncActivityRevision) {
					this.updateState({ status: 'error', lastError: `Could not check local changes: ${errorMessage(error)}`, lastIssues: syncErrorIssues(error) });
				}
			} finally {
				this.updateState({ initializing: false });
			}
		});
	}

	private seedMarkdownBaseCacheInBackground(): void {
		void this.trackWork(() => this.markdownBaseCache.seedFromManifest(this.localManifest, {
			isDestroyed: () => this.lifecycle.isDestroyed,
			runConcurrent: this.runConcurrent.bind(this),
		})).catch((error) => {
			logger.warn('Markdown base cache seed failed:', errorMessage(error));
		});
	}

	private recoverConflictStoreInBackground(): void {
		if (this.lifecycle.isDestroyed) return;
		const ignoreMatcherContext = this.getIgnoreMatcherContext();
		void this.trackWork(() => this.conflictStore.recoverFromVault(
			(path) => shouldIgnoreConfiguredPath(path, ignoreMatcherContext),
			() => this.lifecycle.isDestroyed,
		)).catch((error) => {
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
		if (this.lifecycle.isDestroyed) return;
		void this.trackWork(() => this.markdownBaseCache.pruneUnreferenced(this.localManifest)).catch((error) => {
			logger.warn('Markdown base cache prune failed:', errorMessage(error));
		});
	}

	private isAbortError(error: unknown): boolean {
		return isSyncAbortError(error);
	}

	private verifyPendingPaths(keys: string[], isCurrent: (key: string) => boolean): Promise<string[]> {
		const revision = this.syncActivityRevision;
		return verifyUnchangedPendingPaths({
			adapter: this.vault.adapter,
			manifest: this.localManifest,
			isCurrent: key => isCurrent(key) && revision === this.syncActivityRevision
				&& this.localManifest.uploadJournal.pending().length === 0
				&& this.files.getPendingRestores().length === 0,
		}, keys);
	}

	async onRawFileChange(path: string): Promise<void> {
		const configDir = this.vault.configDir;
		if (!isHiddenPath(path) && !path.startsWith(`${configDir}/`)) return;
		if (this.lifecycle.isDestroyed || this.shouldIgnore(path)) return;
		const revision = {};
		this.rawEventRevisions.set(path, revision);
		const isCurrent = () => !this.lifecycle.isDestroyed
			&& this.rawEventRevisions.get(path) === revision && !this.shouldIgnore(path);
		try {
			assertLocalSyncPath(path);
			const stat = await this.vault.adapter.stat(path);
			if (!isCurrent()) return;
			if (stat?.type === 'file' && this.localManifest.hasFile(path)
				&& this.state.status !== 'syncing' && !this.getPendingPaths().includes(path)) {
				// Obsidian and iCloud can touch settings without changing their bytes.
				// Check before publishing a pending entry; serialize reads to bound memory.
				const activityRevision = this.syncActivityRevision;
				const verification = this.rawVerificationTask.then(() => this.verifyPendingPaths([path],
					() => isCurrent() && this.state.status !== 'syncing' && activityRevision === this.syncActivityRevision));
				this.rawVerificationTask = verification.catch(() => {});
				const settled = await this.trackWork(() => verification).catch((error): string[] => {
					logger.warn('Could not verify changed configuration file:', errorMessage(error));
					return [];
				});
				if (!isCurrent() || settled.includes(path)) return;
			}
			if (stat?.type === 'file') this.queueController.onFileChange({ path });
			else if (!stat) this.queueController.onFileDelete({ path });
		} catch (error) {
			logger.warn('Failed to inspect changed configuration file:', errorMessage(error));
		} finally {
			if (this.rawEventRevisions.get(path) === revision) this.rawEventRevisions.delete(path);
		}
	}

	onFileChange(file: TAbstractFile): void {
		if (this.lifecycle.isDestroyed) return;
		if (isConflictFile(file.path)) {
			void this.trackWork(() => this.conflictStore.registerDiscovered(file.path)).catch((error) => {
				logger.warn('Failed to register conflict copy:', errorMessage(error));
			});
		}
		this.queueController.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		if (this.lifecycle.isDestroyed) return;
		if (isConflictFile(file.path)) {
			void this.trackWork(() => this.conflictStore.markResolved(file.path)).catch((error) => {
				logger.warn('Failed to resolve conflict copy:', errorMessage(error));
			});
		}
		this.queueController.onFileDelete(file);
	}

	getRenameDependencies(): Record<string, string> { return this.localManifest.getRenameDependencies(); }

	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (this.lifecycle.isDestroyed) return;
		if (!this.shouldIgnore(oldPath) && !this.shouldIgnore(file.path)) this.localManifest.recordRename(oldPath, file.path, file instanceof TFolder ? 'folder' : 'file');
		if (isConflictFile(oldPath)) {
			void this.trackWork(() => this.conflictStore.markResolved(oldPath)).catch((error) => {
				logger.warn('Failed to resolve renamed conflict copy:', errorMessage(error));
			});
		}
		if (isConflictFile(file.path)) {
			void this.trackWork(() => this.conflictStore.registerDiscovered(file.path)).catch((error) => {
				logger.warn('Failed to register renamed conflict copy:', errorMessage(error));
			});
		}
		this.queueController.onFileRename(file, oldPath);
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

	private verifyContent(files: VaultFile[]): Promise<boolean> {
		return this.trackWork(() => this.contentVerifier.verify(this.vault, this.localManifest, files, this.lifecycle.abortSignal));
	}

	/** While automatic sync is off, surface same-metadata edits as pending changes. */
	private async verifyTrackedContent(): Promise<void> {
		if (this.state.status === 'syncing' || this.state.initializing || !this.api.isConfigured()) return;
		const revision = this.syncActivityRevision;
		await this.trackWork(async () => {
			const changed = await this.contentVerifier.verifyTracked(this.vault, this.localManifest, path => this.shouldIgnore(path), this.lifecycle.abortSignal);
			if (changed.length && revision === this.syncActivityRevision && !this.settings.automaticSync) {
				this.queueController.restorePendingPaths(changed.map(path => pendingChangeKey('upload', path)));
			}
		});
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
			await this.pendingChanges().settleSynced(result, pendingRevisionSnapshot);
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
			let result = createEmptySyncResult();
			try {
				result = await this.reconcilePaths(queueKeys, !selectedOnly);
				if (result.outcome === 'cancelled') {
					this.updateState({ status: 'idle' });
					return result;
				}
				await this.pendingChanges().settleSynced(result, pendingRevisionSnapshot);
				if (result.success) {
					if (!selectedOnly) await this.contexts.finishInitialSetup();
					const lastSync = new Date().toISOString();
					updateSyncProgress(this.settings, { lastSync });
					this.updateState({
						status: 'idle',
						lastSync,
						lastError: null,
					});
					this.pruneMarkdownBaseCacheInBackground();
				} else {
					this.updateState({ status: 'error', lastError: result.errors[0] ?? 'Reconciliation failed', lastIssues: getSyncIssues(result) });
				}
				return result;
			} catch (error) {
				if (this.isAbortError(error)) {
					this.updateState({ status: 'idle' });
					return cancelSyncResult(result);
				}
				recordSyncError(result, error);
				finalizeSyncResult(result);
				this.updateState({ status: 'error', lastError: result.errors[0] ?? 'Reconciliation failed', lastIssues: getSyncIssues(result) });
				return result;
			}
		});
	}

	private async reconcileVersionConflicts(paths: string[], result: SyncResult): Promise<void> {
		const reconciliation = await this.reconcilePaths(paths);
		mergeSyncResults(result, reconciliation);
		if (reconciliation.outcome === 'cancelled') throw createAbortError('Sync reconciliation aborted');
	}

	private async reconcilePaths(queueKeys: string[], recover = true): Promise<SyncResult> {
		if (recover) await this.files.recoverUploads((current, total) => this.updateState({ work: { phase: 'recovering', current, total } }));
		this.lifecycle.throwIfDestroyed();
		return reconcileQueuePaths({
			reportWork: work => this.updateState({ work }),
			vault: this.vault,
			localManifest: this.localManifest,
			getRemoteEntries: async (paths) => (await this.api.getFileMetadata(paths)).files,
			deleteRemoteFiles: this.contexts.deleteRemoteFiles,
			shouldIgnore: this.shouldIgnore.bind(this),
			uploadDiffs: async (diffs, result) => {
				const retryPaths: string[] = [];
				await uploadFullSyncPlan({
					...this.contexts.syncWorkflow(),
					uploadPreparedFiles: (prepared, syncResult, options) => this.contexts.uploadPreparedFiles(prepared, syncResult, {
						...options,
						onVersionConflicts: async paths => { retryPaths.push(...paths); },
					}),
				}, diffs, createPathRecord<FileEntry>(), result, () => {});
				return retryPaths;
			},
			processDiff: (diff, localFiles, syncResult) =>
				this.contexts.processDiff(diff, localFiles, syncResult),
		}, queueKeys);
	}

	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.trackWork(async () => {
			void this.retryReminderScope();
			const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
			const result = await runInitialSyncWorkflow(this.contexts.initialSyncWorkflow(), progressCallback);
			await this.pendingChanges().settleSynced(result, pendingRevisionSnapshot);
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
			await this.pendingChanges().settleSynced(result, pendingRevisionSnapshot);
			if (result.success) {
				this.pruneMarkdownBaseCacheInBackground();
			}
			return result;
		});
	}

	private async trackWork<T>(operation: () => Promise<T>): Promise<T> {
		this.lifecycle.throwIfDestroyed();
		// Register before dispatch: synchronous host callbacks may stop the engine
		// while operation() is starting its first asynchronous write.
		let finish!: () => void;
		const active = new Promise<void>(resolve => { finish = resolve; });
		this.activeWork.add(active);
		try { return await operation(); }
		finally { this.activeWork.delete(active); finish(); }
	}

	async waitForIdle(): Promise<void> {
		if (this.shutdownTask) return this.shutdownTask;
		await Promise.allSettled([...this.activeWork, this.queueController.waitForIdle(), this.localManifest.close()]);
		// A shutdown begun during this wait may own additional accepted work.
		return this.shutdownTask ?? undefined;
	}

	destroy(): void {
		if (this.lifecycle.isDestroyed) return;
		if (this.conflictRecoveryTimer !== null) {
			clearTimeout(this.conflictRecoveryTimer);
			this.conflictRecoveryTimer = null;
		}
		this.lifecycle.destroy();
		this.queueController.destroy();
		// Accepted transfers and recovery jobs may still enqueue conflict metadata
		// after awaited I/O. Close that store only after its producers have drained.
		this.shutdownTask = Promise.allSettled([
			...this.activeWork,
			this.queueController.waitForIdle(),
			this.localManifest.close(),
		]).then(() => this.conflictStore.close());
	}
}
