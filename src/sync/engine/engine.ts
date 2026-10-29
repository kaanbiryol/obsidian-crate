import { pendingChangeKey } from '../pending/pending-change';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import { createEngineFileOperations, type EngineFileOperations } from './file-operations';
import { createEngineHistory } from './history';
import { createEnginePendingChanges } from './pending-changes';
import { getSyncIssues, syncErrorIssues } from '../issues';
import { findStartupPendingPaths } from '../pending/startup-pending';
import { SyncTimingRecorder } from '../diagnostics/timings';
/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import { TFolder, type Plugin, type TAbstractFile, type Vault } from 'obsidian';
import { SyncApiClient } from '../worker-api/client';
import { LocalManifest } from '../manifest/manifest';
import { MarkdownBaseCache } from '../merge/markdown-base-cache';
import { ConflictStore } from '../conflict/store';
import { isConflictFile } from '../conflict/conflict';
import type { VaultFile } from '../local/file-discovery';
import { SyncQueueController } from '../queue/controller';
import { createAbortError, isAbortError } from '../abort';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';
import type { SyncState, SyncResult, ConflictRecord } from '../types';
import type { MutationFailure } from '../../protocol/sync-types';
import { PREPARE_CONCURRENCY } from '../transfer/constants';
import { isAuthError } from '../failures';
import {
	createIgnoreMatcherContext,
	type IgnoreMatcherContext,
	shouldIgnoreConfiguredPath,
	shouldIgnoreSyncPath,
} from '../local/ignore';
import { hasLocalFileChanges } from '../local/local-file-changes';
import { createExclusionCleanupReview } from './exclusion-cleanup';
import { createRawConfigEventHandler } from './raw-config-events';
import { runForceFullSyncWorkflow } from './force-sync-workflow';
import { runSyncWorkflow } from './standard-sync-workflow';
import { AUTH_ERROR_MESSAGE, beginSyncAttempt, completeTransferResult, handleWorkflowError, ReconnectNotice } from '../sync-outcome';
import { SyncEngineContexts } from './contexts';
import { SyncEngineLifecycle } from './lifecycle';
import { createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import { mergeSyncResults } from '../sync-result';
import { getCheckpointAuthority } from '../connection/worker-url';
import { LocalContentVerifier } from './content-verifier';
import { verifyUnchangedPendingPaths } from '../pending/pending-verification';
import { assertNoOpenInitialImport } from './initial-import';
import { MAX_DEBOUNCE_WAIT_MS, type SyncSettings } from '../settings';
import { isMarkdownNoteInFolder } from '../../protocol/note-paths';

const logger = createLogger('SyncEngine');

export class SyncEngine {
	private plugin: Plugin;
	private vault: Vault;
	private api: SyncApiClient;
	private readonly files: EngineFileOperations;
	private localManifest: LocalManifest;
	private markdownBaseCache: MarkdownBaseCache;
	private conflictStore: ConflictStore;
	private settings: SyncSettings;
	private state: SyncState;
	private queueController: SyncQueueController;
	private lifecycle: SyncEngineLifecycle;
	private contexts: SyncEngineContexts;
	private timingRecorder = new SyncTimingRecorder();
	getTimings() { return { ...this.timingRecorder.snapshot(), requests: this.api.getRequestTimings() }; }
	private onStateChange: ((state: SyncState) => void) | null = null;
	private activeWork = new Set<Promise<unknown>>();
	private shutdownTask: Promise<void> | null = null;
	private contentVerifier: LocalContentVerifier;
	private periodicCheckFailed = false;
	private onAutomaticSyncResult: ((result: SyncResult) => void | Promise<void>) | null = null;
	private prepareReminderScope?: () => Promise<void>;
	private readonly rawConfigEvents: (path: string) => Promise<void>;
	private ignore: IgnoreMatcherContext;
	private syncActivityRevision = 0;
	private conflictRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Per engine, so new credentials (a new engine) can show the notice again. */
	private readonly reconnectNotice = new ReconnectNotice();

	constructor(
		plugin: Plugin,
		api: SyncApiClient,
		settings: SyncSettings,
		/** Tests pass a manifest they observe or wrap the file operations; production lets the engine create both. */
		stores: { localManifest?: LocalManifest; createFiles?: typeof createEngineFileOperations } = {},
	) {
		this.plugin = plugin;
		this.vault = plugin.app.vault;
		this.api = api;
		this.settings = settings;
		this.localManifest = stores.localManifest ?? new LocalManifest(plugin.app, plugin.manifest, getCheckpointAuthority(settings) || 'unconfigured');
		this.contentVerifier = new LocalContentVerifier({
			adapter: this.vault.adapter,
			path: `${plugin.manifest.dir}/content-verification.json`,
			authority: getCheckpointAuthority(settings) || 'unconfigured',
		});
		this.markdownBaseCache = new MarkdownBaseCache(plugin.app, plugin.manifest);
		const { transport, clientSession } = this.api.getFileTransport(this.localManifest);
		this.files = (stores.createFiles ?? createEngineFileOperations)(transport, this.localManifest, this.vault, this.markdownBaseCache, clientSession);
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
		this.ignore = this.createIgnoreContext(settings);
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
		this.contexts = new SyncEngineContexts({
			prepareReminderScope: async () => { await this.prepareReminderScope?.(); },
			vault: this.vault,
			fileManager: this.plugin.app.fileManager,
			api: this.api,
			files: this.files,
			localManifest: this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			conflictStore: this.conflictStore,
			getSettings: () => this.settings,
			getStatus: () => this.state.status,
			shouldIgnore: this.shouldIgnore.bind(this),
			runConcurrent: (tasks, concurrency) => this.lifecycle.runConcurrent(tasks, concurrency),
			retryWithBackoff: operation => this.lifecycle.retryWithBackoff(operation),
			getModifiedIso: this.getModifiedIso.bind(this),
			getPendingKeys: () => this.queueController.getPendingKeys(),
			verifyContent: files => this.verifyContent(files),
			reconcileVersionConflicts: (paths, result) => this.reconcileVersionConflicts(paths, result),
			updateState: this.updateState.bind(this),
			reconnectNotice: this.reconnectNotice,
			throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
		});
		this.queueController = new SyncQueueController({
			finishInitialSetup: this.contexts.finishInitialSetup,
			uploadPreparedFiles: this.contexts.uploadPreparedFiles,
			deleteRemoteFiles: this.contexts.deleteRemoteFiles,
			automaticSyncEnabled: () => this.settings.automaticSync,
			recoverUploads: async () => {
				void this.retryReminderScope();
				await assertNoOpenInitialImport(this.api);
				await this.contexts.recoverUploads();
				this.updateState({ work: { phase: 'applying' } });
			},
			api: {
				isConfigured: () => this.api.isConfigured(),
			},
			localManifest: this.localManifest,
			shouldIgnore: this.shouldIgnore.bind(this),
			updateState: this.updateState.bind(this),
			setLastSync: this.contexts.setLastSync,
			reconnectNotice: this.reconnectNotice,
			isDestroyed: () => this.lifecycle.isDestroyed,
			currentStatus: () => this.state.status,
			verifyPendingPaths: (keys, isCurrent) => this.verifyPendingPaths(keys, isCurrent),
			prepareUploadFromPath: this.contexts.prepareUploadFromPath,
			getDebounceDelayMs: () => (this.settings.debounceDelay ?? 5) * 1000,
			maxDebounceWaitMs: MAX_DEBOUNCE_WAIT_MS,
			reconcile: (queueKeys) => this.reconcileFromQueue(queueKeys),
			onFlushResult: (result) => this.onAutomaticSyncResult?.(result),
		});
		this.rawConfigEvents = createRawConfigEventHandler({
			vault: this.vault,
			manifest: this.localManifest,
			queue: this.queueController,
			isDestroyed: () => this.lifecycle.isDestroyed,
			isSyncing: () => this.state.status === 'syncing',
			shouldIgnore: this.shouldIgnore.bind(this),
			captureSyncActivity: () => this.captureSyncActivity(),
			verifyPendingPaths: (keys, isCurrent) => this.verifyPendingPaths(keys, isCurrent),
			trackWork: operation => this.trackWork(operation),
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

	updateSettings(settings: SyncSettings): void {
		this.settings = settings;
		this.ignore = this.createIgnoreContext(settings);
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
			throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
			isDestroyed: () => this.lifecycle.isDestroyed,
			beforeBinaryReplace: path => this.prepareRecoverableReplacement(path),
		});
	}

	async loadPendingDiff(path: string, deleted: boolean) {
		return this.pendingChanges().loadDiff(path, deleted);
	}

	getPendingKeys(): string[] {
		return this.queueController.getPendingKeys();
	}

	getPendingChangeCount(): number {
		return this.queueController.getPendingChangeCount();
	}

	hasPendingKey(key: string): boolean {
		return this.queueController.hasPendingKey(key);
	}

	private history() {
		return createEngineHistory({
			vault: this.vault, api: this.api, pluginDir: `${this.plugin.manifest.dir}`,
			getSettings: () => this.settings, getManifest: () => this.localManifest.getManifest(),
			shouldIgnore: path => this.shouldIgnore(path),
			throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
			hasPendingMutations: () => Boolean(this.getActiveConflicts().length
				|| this.localManifest.uploadJournal.pending().length || this.files.getPendingRestores().length),
			canCheckpoint: () => !this.lifecycle.isDestroyed && this.state.status !== 'syncing',
			runExclusive: operation => this.runExclusiveOperation(operation),
			applied: (path, removed) => this.queueController.restorePendingPaths([pendingChangeKey(removed ? 'delete' : 'upload', path)]),
		});
	}

	async saveSharedHistoryCheckpoint() { return this.trackWork(() => this.history().saveShared()); }
	trackedFileCount(): number { return this.localManifest.getAllPaths().length; }
	trackedPaths(): string[] { return this.localManifest.getAllPaths(); }

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

	/** Uploads synced Markdown under `folder` again, unchanged, so the server receives its
	 * current encrypted metadata, such as reminder schedules after the Reminders folder
	 * changes. Each upload is conditional; a conflict is left to the next ordinary sync. */
	async republishMarkdown(folder: string): Promise<number> {
		return this.runExclusiveOperation(async () => {
			const paths = this.localManifest.getAllPaths().filter(path => isMarkdownNoteInFolder(path, folder));
			const result = createEmptySyncResult();
			for (let offset = 0; offset < paths.length; offset += 50) {
				this.lifecycle.throwIfDestroyed();
				const prepared = [];
				for (const path of paths.slice(offset, offset + 50)) {
					const upload = await this.contexts.prepareRepublish(path);
					if (upload) prepared.push(upload);
				}
				if (prepared.length) await this.contexts.uploadPreparedFiles(prepared, result, { retry: true });
			}
			await this.localManifest.save();
			return result.uploaded;
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
		const pending = new Set(this.getPendingKeys());
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
			throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
			runExclusive: operation => this.runExclusiveOperation(operation),
			retryWithBackoff: operation => this.lifecycle.retryWithBackoff(operation),
			batchDelete: (...args) => this.files.batchDelete(...args),
			manifest: this.localManifest,
		});
	}

	/**
	 * Publishes state, and treats `syncing` as the engine's busy state. Entering it
	 * starts a new sync activity: pending verifications, startup scans and content
	 * checks begun earlier no longer apply their results, and phase and request
	 * timings restart. Leaving it stops the timings and resumes pending checks that
	 * waited for the engine to be idle.
	 *
	 * `runExclusiveOperation` reuses `syncing` for conflict resolution, discards,
	 * history restores and exclusion cleanup, so they have these effects too. Those
	 * operations write local state, so earlier reads cannot settle pending paths
	 * afterwards; each sync restarts the timings before it records them.
	 */
	private updateState(updates: Partial<SyncState>): void {
		if (this.lifecycle?.isDestroyed) return;
		if (updates.status === 'syncing' && this.state.status !== 'syncing') {
			this.syncActivityRevision++;
			this.timingRecorder.start(); this.api.resetRequestTimings();
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
		return shouldIgnoreSyncPath(path, this.ignoreContext());
	}

	/** Settings writes can replace the pattern list in place before updateSettings runs. */
	private ignoreContext(): IgnoreMatcherContext {
		if (this.ignore.ignorePatterns !== this.settings.ignorePatterns) this.ignore = this.createIgnoreContext(this.settings);
		return this.ignore;
	}

	private createIgnoreContext(settings: SyncSettings): IgnoreMatcherContext {
		const pluginDir = this.plugin.manifest.dir?.replace(/\/+$/, '');
		return createIgnoreMatcherContext(
			[...(pluginDir ? [`${pluginDir}/`] : []), this.markdownBaseCache.getIgnoredPrefix()],
			settings.ignorePatterns,
		);
	}

	/** A pending-change scan stays current until sync activity starts. */
	private captureSyncActivity(): () => boolean {
		const revision = this.syncActivityRevision;
		return () => revision === this.syncActivityRevision;
	}

	private restoreStartupPendingChanges(): void {
		if (this.lifecycle.isDestroyed) return;
		if (this.state.status === 'syncing') {
			this.updateState({ initializing: false });
			return;
		}
		const activityCurrent = this.captureSyncActivity();
		void this.trackWork(async () => {
			try {
				const paths = await findStartupPendingPaths({
					vault: this.vault,
					baseline: this.localManifest.getManifest().files,
					shouldIgnore: path => this.shouldIgnore(path),
					throwIfDestroyed: () => this.lifecycle.throwIfDestroyed(),
					verifyContent: files => this.verifyContent(files),
					runConcurrent: (tasks, concurrency) => this.lifecycle.runConcurrent(tasks, concurrency),
				}, PREPARE_CONCURRENCY);
				if (activityCurrent() && !this.settings.automaticSync) {
					this.queueController.restorePendingPaths(paths);
				}
			} catch (error) {
				if (!isAbortError(error) && activityCurrent()) {
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
			runConcurrent: (tasks, concurrency) => this.lifecycle.runConcurrent(tasks, concurrency),
		})).catch((error) => {
			if (!isAbortError(error)) logger.warn('Markdown base cache seed failed:', errorMessage(error));
		});
	}

	private recoverConflictStoreInBackground(): void {
		if (this.lifecycle.isDestroyed) return;
		const ignoreMatcherContext = this.ignoreContext();
		void this.trackWork(() => this.conflictStore.recoverFromVault(
			(path) => shouldIgnoreConfiguredPath(path, ignoreMatcherContext),
			() => this.lifecycle.isDestroyed,
			this.baselineRevision,
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


	private verifyPendingPaths(keys: string[], isCurrent: (key: string) => boolean): Promise<string[]> {
		const activityCurrent = this.captureSyncActivity();
		return verifyUnchangedPendingPaths({
			adapter: this.vault.adapter,
			manifest: this.localManifest,
			isCurrent: key => isCurrent(key) && activityCurrent()
				&& this.localManifest.uploadJournal.pending().length === 0
				&& this.files.getPendingRestores().length === 0,
		}, keys);
	}

	onRawFileChange(path: string): Promise<void> {
		return this.rawConfigEvents(path);
	}

	/** Queues changes whose vault events the runtime dropped, as live events would. */
	restoreDroppedEvents(keys: string[]): void {
		this.queueController.restoreDroppedEvents(keys);
	}

	onFileChange(file: TAbstractFile): void {
		if (this.lifecycle.isDestroyed) return;
		if (isConflictFile(file.path)) {
			this.updateConflictCopy(() => this.conflictStore.registerDiscovered(file.path), 'Failed to register conflict copy:');
		}
		this.queueController.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		if (this.lifecycle.isDestroyed) return;
		if (isConflictFile(file.path)) {
			this.updateConflictCopy(() => this.conflictStore.markResolved(file.path, this.baselineRevision), 'Failed to resolve conflict copy:');
		}
		this.queueController.onFileDelete(file);
	}


	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (this.lifecycle.isDestroyed) return;
		if (!this.shouldIgnore(oldPath) && !this.shouldIgnore(file.path)) this.localManifest.recordRename(oldPath, file.path, file instanceof TFolder ? 'folder' : 'file');
		if (isConflictFile(oldPath)) {
			this.updateConflictCopy(() => this.conflictStore.markResolved(oldPath, this.baselineRevision), 'Failed to resolve renamed conflict copy:');
		}
		if (isConflictFile(file.path)) {
			this.updateConflictCopy(() => this.conflictStore.registerDiscovered(file.path), 'Failed to register renamed conflict copy:');
		}
		this.queueController.onFileRename(file, oldPath);
	}

	private readonly baselineRevision = (path: string): string | undefined => this.localManifest.getEntry(path)?.revision;

	private updateConflictCopy(update: () => Promise<void>, failureMessage: string): void {
		void this.trackWork(update).catch((error) => {
			logger.warn(failureMessage, errorMessage(error));
		});
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
		const activityCurrent = this.captureSyncActivity();
		await this.trackWork(async () => {
			const changed = await this.contentVerifier.verifyTracked(this.vault, this.localManifest, path => this.shouldIgnore(path), this.lifecycle.abortSignal);
			if (changed.length && activityCurrent() && !this.settings.automaticSync) {
				this.queueController.restorePendingPaths(changed.map(path => pendingChangeKey('upload', path)));
			}
		});
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runTrackedWorkflow(async () => {
			this.contexts.clearPlannedContent();
			try {
				return await runSyncWorkflow(this.contexts.syncWorkflow, progressCallback);
			} finally {
				this.contexts.clearPlannedContent();
			}
		});
	}


	private async reconcileFromQueue(queueKeys: string[], selectedOnly = false): Promise<SyncResult> {
		return this.trackWork(async () => {
			const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
			const startFailure = beginSyncAttempt({
				apiConfigured: () => this.api.isConfigured(),
				getStatus: () => this.state.status,
				updateState: updates => this.updateState(updates),
			});
			if (startFailure) return startFailure;
			const outcome = { updateState: this.updateState.bind(this), setLastSync: this.contexts.setLastSync, reconnectNotice: this.reconnectNotice };
			let result = createEmptySyncResult();
			const failures: MutationFailure[] = [];
			try {
				result = await this.reconcilePaths(queueKeys, !selectedOnly, failure => { failures.push(failure); });
				if (result.outcome !== 'cancelled') {
					await this.pendingChanges().settleSynced(result, pendingRevisionSnapshot);
					if (result.success && !selectedOnly) await this.contexts.finishInitialSetup();
				}
				completeTransferResult(outcome, result, failures, { errorFallback: 'Reconciliation failed', failureLogPrefix: 'Reconciliation failed', logger });
				if (result.success) this.pruneMarkdownBaseCacheInBackground();
				return result;
			} catch (error) {
				handleWorkflowError(outcome, result, error, {
					abortLogMessage: 'Reconciliation aborted',
					failureLogPrefix: 'Reconciliation failed',
					logger,
				});
				finalizeSyncResult(result);
				return result;
			}
		});
	}

	private async reconcileVersionConflicts(paths: string[], result: SyncResult): Promise<void> {
		const reconciliation = await this.reconcilePaths(paths);
		mergeSyncResults(result, reconciliation);
		if (reconciliation.outcome === 'cancelled') throw createAbortError('Sync reconciliation aborted');
	}

	private async reconcilePaths(queueKeys: string[], recover = true, onFailure?: (failure: MutationFailure) => void): Promise<SyncResult> {
		await assertNoOpenInitialImport(this.api);
		if (recover) await this.contexts.recoverUploads();
		this.lifecycle.throwIfDestroyed();
		return this.contexts.reconcileQueuePaths(queueKeys, onFailure);
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runTrackedWorkflow(() => runForceFullSyncWorkflow(this.contexts.forceSyncWorkflow, progressCallback));
	}

	private async runTrackedWorkflow(run: () => Promise<SyncResult>): Promise<SyncResult> {
		return this.trackWork(async () => {
			void this.retryReminderScope();
			const pendingRevisionSnapshot = this.queueController.snapshotPendingRevisions();
			const result = await run();
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

	/** After destroy, resolves once shutdown drains; before it, waits for accepted work without closing stores. */
	async waitForIdle(): Promise<void> {
		if (this.shutdownTask) return this.shutdownTask;
		await Promise.allSettled([...this.activeWork, this.queueController.waitForIdle(), this.localManifest.whenSaved()]);
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
