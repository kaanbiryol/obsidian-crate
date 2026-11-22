import { decodePendingChange, pendingChangeKey } from '../pending/pending-change';
import type { RemoteFileVersion } from '../../protocol/sync-types';
import { createEngineFileOperations, type EngineFileOperations } from './file-operations';
import { createEngineHistory } from './history';
import { createEnginePendingChanges } from './pending-changes';
import { getSyncIssues, syncErrorIssues } from '../issues';
import { SyncTimingRecorder } from '../diagnostics/timings';
/**
 * Core sync engine - orchestrates synchronization between local vault and remote storage
 */

import type { Plugin, Vault } from 'obsidian';
import { SyncApiClient } from '../worker-api/client';
import { LocalManifest } from '../manifest/manifest';
import { MarkdownBaseCache } from '../merge/markdown-base-cache';
import { ConflictStore } from '../conflict/store';
import { ConflictTracking } from './conflict-tracking';
import { SyncQueueController } from '../queue/controller';
import { isAbortError } from '../abort';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';
import type { SyncState, SyncResult, ConflictRecord, VaultEntry } from '../types';
import { uploadPipelined } from '../transfer/upload-pipeline';
import { getModifiedIso } from '../transfer/applied-content';
import { isAuthError } from '../failures';
import { createSyncIgnoreMatcher, type SyncIgnoreMatcher } from '../local/ignore';
import { createExclusionCleanupReview } from './exclusion-cleanup';
import { createRawConfigEventHandler } from './raw-config-events';
import { runForceFullSyncWorkflow } from './force-sync-workflow';
import { AUTH_ERROR_MESSAGE, ReconnectNotice } from '../sync-outcome';
import { SyncEngineContexts } from './contexts';
import { runReconcileWorkflow } from './reconcile-workflow';
import { SyncEngineLifecycle } from './lifecycle';
import { createEmptySyncResult, SYNC_ERROR_MESSAGES } from '../sync-result';
import { getCheckpointAuthority } from '../connection/worker-url';
import { LocalChangeDetection } from './local-changes';
import { hasRemoteChanges } from './remote-changes';
import type { SyncSettings } from '../settings';
import { syncStoragePaths } from '../manifest/storage-paths';
import { isMarkdownNoteInFolder } from '../../protocol/note-paths';

const logger = createLogger('SyncEngine');

/** What the engine needs from its owner. Read at call time, so the owner may replace one. */
export interface SyncEngineHooks {
	/** Lets a sync save settings before it finishes, when a restart must not lose a change. */
	persistSettings: () => Promise<void>;
	onStateChange?: (state: SyncState) => void;
	/** Results of syncs the engine started itself: periodic checks, queue flushes and reconciliation. */
	onAutomaticSyncResult?: (result: SyncResult) => void | Promise<void>;
	prepareReminderScope?: () => Promise<void>;
	/** Runs when a first upload starts, before it lists vault files. */
	prepareInitialUpload?: () => Promise<void>;
	/** Runs at the check interval while automatic sync is off, for checks that never sync. */
	onManualCheckDue?: () => void;
}

export type SyncEngineHost = Pick<Plugin, 'app' | 'manifest'>;

export class SyncEngine {
	private plugin: SyncEngineHost;
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
	private activeWork = new Set<Promise<unknown>>();
	private shutdownTask: Promise<void> | null = null;
	private readonly localChanges: LocalChangeDetection;
	private periodicCheckFailed = false;
	/** Counts full-sync requests, so a sync clears only the requests made before it read them. */
	private fullSyncRequestGeneration = 0;
	private readonly rawConfigEvents: (path: string) => Promise<void>;
	private readonly ignore: SyncIgnoreMatcher;
	private syncActivityRevision = 0;
	private readonly conflicts: ConflictTracking;
	/** Per engine, so new credentials (a new engine) can show the notice again. */
	private readonly reconnectNotice = new ReconnectNotice();
	private readonly storage: ReturnType<typeof syncStoragePaths>;

	constructor(
		plugin: SyncEngineHost,
		api: SyncApiClient,
		settings: SyncSettings,
		private readonly hooks: SyncEngineHooks,
		/** Tests pass stores they observe or wrap the file operations; production lets the engine create them. */
		stores: {
			localManifest?: LocalManifest;
			createFiles?: typeof createEngineFileOperations;
			/** Receives the callback that publishes the active conflict count. */
			createConflictStore?: (onActiveCountChange: (count: number) => void) => ConflictStore;
		} = {},
	) {
		this.plugin = plugin;
		this.vault = plugin.app.vault;
		this.api = api;
		this.settings = settings;
		// Plugin files keep the folder as Obsidian reports it, as the manifest and conflict
		// stores do; matching vault paths needs it without a trailing slash.
		this.storage = syncStoragePaths(`${plugin.manifest.dir}`);
		const pluginFolder = plugin.manifest.dir!.replace(/\/+$/, '');
		this.localManifest = stores.localManifest ?? new LocalManifest(plugin.app, plugin.manifest, getCheckpointAuthority(settings) || 'unconfigured');
		this.markdownBaseCache = new MarkdownBaseCache(plugin.app, plugin.manifest);
		const { transport, clientSession } = this.api.getFileTransport(this.localManifest);
		this.files = (stores.createFiles ?? createEngineFileOperations)(transport, this.localManifest, this.vault, this.markdownBaseCache, clientSession, () => this.api.fileLimit());
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
		const onActiveCountChange = (conflictCount: number) => {
			this.updateState({ conflictCount });
		};
		this.conflictStore = stores.createConflictStore?.(onActiveCountChange)
			?? new ConflictStore(plugin.app, plugin.manifest, onActiveCountChange);
		this.ignore = createSyncIgnoreMatcher(
			() => [...(pluginFolder ? [`${pluginFolder}/`] : []), this.markdownBaseCache.getIgnoredPrefix()],
			() => this.settings.ignorePatterns,
		);
		this.lifecycle = new SyncEngineLifecycle({
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			automaticSyncEnabled: () => this.settings.automaticSync,
			getSyncIntervalSeconds: () => this.settings.automaticSync ? this.settings.syncInterval : 0,
			getLastSeq: () => this.settings.lastSeq,
			getQueuedKeyCount: () => this.queueController.getQueuedKeyCount(),
			fullSyncRequested: () => this.settings.fullSyncRequested === true,
			hasLocalFileChanges: async () => this.localManifest.uploadJournal.pending().length > 0 || await this.hasUnsyncedLocalChanges(),
			verifyLocalContent: () => this.localChanges.verifyTracked(),
			getManualCheckSeconds: () => this.settings.syncInterval,
			manualCheckDue: () => this.hooks.onManualCheckDue?.(),
			checkForChanges: async (lastSeq: number) => {
				void this.retryReminderScope();
				return this.api.checkForChanges(lastSeq);
			},
			sync: async () => {
				const result = await this.sync();
				if (!this.lifecycle.abortSignal.aborted) await this.hooks.onAutomaticSyncResult?.(result);
				return result;
			},
			onCheckSuccess: () => {
				if (this.periodicCheckFailed) this.updateState({ status: 'idle', lastError: null });
			},
			onCheckFailure: error => {
				if (this.lifecycle.abortSignal.aborted || this.state.status === 'syncing') return;
				this.updateState({ status: 'error', lastError: isAuthError(error) ? AUTH_ERROR_MESSAGE : `Sync check failed: ${errorMessage(error)}`,
					...(!isAuthError(error) ? { lastIssues: syncErrorIssues(error) } : {}),
				});
				this.periodicCheckFailed = true;
			},
		});
		this.api.setAbortSignal(this.lifecycle.abortSignal);
		this.localChanges = new LocalChangeDetection({
			vault: this.vault,
			manifest: this.localManifest,
			verification: { path: this.storage.contentVerification, authority: getCheckpointAuthority(settings) || 'unconfigured' },
			shouldIgnore: this.ignore.shouldIgnore,
			getSettings: () => this.settings,
			getState: () => this.state,
			updateState: updates => this.updateState(updates),
			apiConfigured: () => this.api.isConfigured(),
			fileLimit: () => this.api.fileLimit(),
			refreshFileLimit: () => this.api.refreshFileLimit(),
			hasPendingRestores: () => this.files.getPendingRestores().length > 0,
			restorePendingKeys: keys => this.queueController.restorePendingKeys(keys),
			captureSyncActivity: () => this.captureSyncActivity(),
			trackWork: operation => this.trackWork(operation),
			lifecycle: this.lifecycle,
		});
		this.contexts = new SyncEngineContexts({
			prepareReminderScope: async () => { await this.hooks.prepareReminderScope?.(); },
			prepareInitialUpload: async () => { await this.hooks.prepareInitialUpload?.(); },
			vault: this.vault,
			pluginDir: pluginFolder,
			fileManager: this.plugin.app.fileManager,
			api: this.api,
			files: this.files,
			localManifest: this.localManifest,
			markdownBaseCache: this.markdownBaseCache,
			conflictStore: this.conflictStore,
			getSettings: () => this.settings,
			persistSettings: () => this.hooks.persistSettings(),
			pendingFullSyncRequest: () => this.pendingFullSyncRequest(),
			getStatus: () => this.state.status,
			shouldIgnore: this.ignore.shouldIgnore,
			runConcurrent: (tasks, concurrency) => this.lifecycle.runConcurrent(tasks, concurrency),
			retryWithBackoff: operation => this.lifecycle.retryWithBackoff(operation),
			getModifiedIso: (path, fallbackMtime) => getModifiedIso(this.vault.adapter, path, fallbackMtime),
			getPendingKeys: () => this.queueController.getPendingKeys(),
			verifyContent: files => this.localChanges.verifyContent(files),
			updateState: this.updateState.bind(this),
			reconnectNotice: this.reconnectNotice,
			signal: this.lifecycle.abortSignal,
			retryReminderScope: () => this.retryReminderScope(),
			verifyPendingPaths: (keys, isCurrent, replayed) => this.localChanges.verifyPendingPaths(keys, isCurrent, replayed),
			reconcileQueue: async queueKeys => {
				const result = await this.reconcileFromQueue(queueKeys);
				// A refusal because another sync is running is not an attempt; that sync covers these keys.
				const busy = result.errors.length === 1 && result.errors[0] === SYNC_ERROR_MESSAGES.ALREADY_IN_PROGRESS;
				if (!busy && !this.lifecycle.abortSignal.aborted) await this.hooks.onAutomaticSyncResult?.(result);
				return result;
			},
			onFlushResult: result => this.hooks.onAutomaticSyncResult?.(result),
		});
		this.queueController = new SyncQueueController(this.contexts.queue);
		this.rawConfigEvents = createRawConfigEventHandler({
			vault: this.vault,
			manifest: this.localManifest,
			queue: this.queueController,
			signal: this.lifecycle.abortSignal,
			isSyncing: () => this.state.status === 'syncing',
			shouldIgnore: this.ignore.shouldIgnore,
			captureSyncActivity: () => this.captureSyncActivity(),
			verifyPendingPaths: (keys, isCurrent) => this.localChanges.verifyPendingPaths(keys, isCurrent),
			trackWork: operation => this.trackWork(operation),
		});
		this.conflicts = new ConflictTracking({
			store: this.conflictStore,
			api: this.api,
			manifest: this.localManifest,
			queue: this.queueController,
			ignore: this.ignore,
			trackWork: operation => this.trackWork(operation),
			signal: this.lifecycle.abortSignal,
			updateConflictCount: conflictCount => this.updateState({ conflictCount }),
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
		this.lifecycle.abortSignal.throwIfAborted();
		await this.conflictStore.load();
		this.lifecycle.abortSignal.throwIfAborted();
		logger.info('Engine initialized');
		this.plugin.app.workspace.onLayoutReady(() => {
			this.conflicts.scheduleRecovery();
			if (!this.settings.automaticSync) this.localChanges.restorePending();
			else this.updateState({ initializing: false });
		});
		this.seedMarkdownBaseCacheInBackground();

		this.lifecycle.startPeriodicSync();
		if (this.settings.automaticSync) this.updateState({ initializing: false });
	}

	updateSettings(settings: SyncSettings): void {
		this.settings = settings;
		this.ignore.reset();
		const removedPattern = this.localChanges.exclusionRemoved(settings.ignorePatterns);
		this.lifecycle.settingsChanged();
		this.queueController.settingsChanged();
		// Files a removed exclusion now includes fire no vault events; list them like the startup scan does.
		if (removedPattern && this.state.initializing === false && !settings.automaticSync) this.localChanges.restorePending();
		if (removedPattern) {
			void this.requestFullSync().catch(error => logger.warn('Could not save the full sync request:', errorMessage(error)));
		}
	}

	/** Server files under a removed exclusion are already behind the changelog cursor, so
	 * only a full sync finds them. Saved at once, so a restart still runs it. */
	private async requestFullSync(): Promise<void> {
		this.fullSyncRequestGeneration++;
		this.settings.fullSyncRequested = true;
		await this.hooks.persistSettings();
	}

	/** The pending full-sync request. `complete` clears it unless a newer one arrived. */
	private pendingFullSyncRequest(): { complete(): void } | null {
		if (!this.settings.fullSyncRequested) return null;
		const requests = this.fullSyncRequestGeneration;
		return { complete: () => { if (requests === this.fullSyncRequestGeneration) delete this.settings.fullSyncRequested; } };
	}

	private async retryReminderScope(): Promise<void> {
		try {
			await this.hooks.prepareReminderScope?.();
		} catch (error) {
			if (!this.lifecycle.abortSignal.aborted) logger.warn('Reminder settings will retry on the next sync:', errorMessage(error));
		}
	}

	getState(): SyncState {
		return { ...this.state };
	}

	/** Whether a sync would bring server changes here. Read-only: it never moves the cursor. */
	hasRemoteChanges(): Promise<boolean> {
		return hasRemoteChanges({
			lastSeq: this.settings.lastSeq,
			checkForChanges: since => this.api.checkForChanges(since),
			files: this.files,
			getBaseline: path => this.localManifest.getEntry(path),
			shouldIgnore: this.ignore.shouldIgnore,
			signal: this.lifecycle.abortSignal,
		});
	}

	private pendingChanges() {
		return createEnginePendingChanges({
			vault: this.vault, api: this.api, manifest: this.localManifest,
			cache: this.markdownBaseCache, queue: this.queueController,
			backupRoot: this.storage.discardRecovery,
			signal: this.lifecycle.abortSignal,
			beforeBinaryReplace: path => this.prepareRecoverableReplacement(path),
		});
	}

	async loadPendingDiff(path: string, deleted: boolean, options?: { localOnly?: boolean }) {
		return this.pendingChanges().loadDiff(path, deleted, options);
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
			vault: this.vault, api: this.api, recoveryRoot: this.storage.stateRecovery,
			getSettings: () => this.settings, getManifest: () => this.localManifest.getManifest(),
			shouldIgnore: this.ignore.shouldIgnore,
			signal: this.lifecycle.abortSignal,
			hasPendingMutations: () => Boolean(this.getActiveConflicts().length
				|| this.localManifest.uploadJournal.pending().length || this.files.getPendingRestores().length),
			canCheckpoint: () => !this.lifecycle.abortSignal.aborted && this.state.status !== 'syncing',
			runExclusive: operation => this.runExclusiveOperation(operation),
			applied: (path, removed) => this.queueController.restorePendingKeys([pendingChangeKey(removed ? 'delete' : 'upload', path)]),
		});
	}

	async saveSharedHistoryCheckpoint() { return this.trackWork(() => this.history().saveShared()); }
	trackedFileCount(): number { return this.localManifest.getAllPaths().length; }
	trackedPaths(): string[] { return this.localManifest.getAllPaths(); }
	/** Server files outside this device's exclusions that it does not hold at their server
	 * version, such as one awaiting review, over the size limit or with a name it cannot store. */
	async untrackedServerPaths(): Promise<string[]> {
		const remote = await this.api.getManifest();
		return Object.entries(remote.files).flatMap(([path, entry]) => {
			if (this.ignore.shouldIgnore(path)) return [];
			const local = this.localManifest.getEntry(path);
			const held = local && (entry.revision && local.revision ? local.revision === entry.revision : local.hash === entry.hash);
			return held ? [] : [path];
		});
	}

	async loadHistoryComparison(checkpoint: string) {
		return this.history().compare(checkpoint);
	}

	async createHistoryRestore(checkpoint: string, beforeApply: () => Promise<void>) {
		return this.history().prepareRestore(checkpoint, beforeApply);
	}

	private async runExclusiveOperation<T>(operation: () => Promise<T>, busyMessage = 'Wait for sync to finish, then try again.'): Promise<T> {
		this.lifecycle.abortSignal.throwIfAborted();
		if (this.state.status === 'syncing') throw new Error(busyMessage);
		this.updateState({ status: 'syncing', writesVault: true });
		return this.trackWork(async () => {
			try { return await operation(); }
			finally { if (!this.lifecycle.abortSignal.aborted) this.updateState({ status: 'idle' }); }
		});
	}

	/** Uploads synced Markdown under `folder` again, unchanged, so the server receives its
	 * current encrypted metadata, such as reminder schedules after the Reminders folder
	 * changes. Each upload is conditional; a conflict is left to the next ordinary sync. */
	async republishMarkdown(folder: string): Promise<number> {
		return this.runExclusiveOperation(async () => {
			const paths = this.localManifest.getAllPaths().filter(path => isMarkdownNoteInFolder(path, folder));
			const result = createEmptySyncResult();
			await uploadPipelined(this.contexts, paths, result, {
				prepare: path => {
					this.lifecycle.abortSignal.throwIfAborted();
					return this.contexts.prepareRepublish(path);
				},
				retry: true,
			});
			await this.localManifest.save();
			return result.uploaded;
		});
	}

	async syncSelected(keys: string[]): Promise<SyncResult> {
		this.assertPendingSelection(keys);
		return this.reconcileFromQueue([...new Set(keys)], true);
	}

	private assertPendingSelection(keys: string[]): void {
		this.lifecycle.abortSignal.throwIfAborted();
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
		this.lifecycle.abortSignal.throwIfAborted();
		this.localManifest.removeEntry(path);
		await this.localManifest.save();
		this.lifecycle.abortSignal.throwIfAborted();
	}

	markConflictResolved(path: string): Promise<void> {
		return this.conflicts.markResolved(path);
	}

	/** Preserve the user's keep-local intent without accepting a newer server edit. */
	acceptIncomingConflictBaseline(record: ConflictRecord): Promise<void> {
		return this.conflicts.acceptIncomingBaseline(record);
	}

	getActiveConflicts(): ConflictRecord[] {
		return this.conflictStore.getActiveConflicts();
	}

	hasUnsyncedLocalChanges(): Promise<boolean> {
		return this.localChanges.hasUnsyncedChanges();
	}

	async createExclusionCleanupReview() {
		return createExclusionCleanupReview({
			getManifest: () => this.api.getManifest(),
			getIgnorePatterns: () => this.settings.ignorePatterns,
			shouldIgnore: this.ignore.shouldIgnore,
			signal: this.lifecycle.abortSignal,
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
		if (this.lifecycle?.abortSignal.aborted) return;
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
		this.hooks.onStateChange?.(this.state);
	}

	/** A pending-change scan stays current until sync activity starts. */
	private captureSyncActivity(): () => boolean {
		const revision = this.syncActivityRevision;
		return () => revision === this.syncActivityRevision;
	}

	private seedMarkdownBaseCacheInBackground(): void {
		void this.trackWork(() => this.markdownBaseCache.seedFromManifest(this.localManifest, {
			signal: this.lifecycle.abortSignal,
			runConcurrent: (tasks, concurrency) => this.lifecycle.runConcurrent(tasks, concurrency),
		})).catch((error) => {
			if (!isAbortError(error)) logger.warn('Markdown base cache seed failed:', errorMessage(error));
		});
	}

	private pruneMarkdownBaseCacheInBackground(): void {
		if (this.lifecycle.abortSignal.aborted) return;
		void this.trackWork(() => this.markdownBaseCache.pruneUnreferenced(this.localManifest)).catch((error) => {
			logger.warn('Markdown base cache prune failed:', errorMessage(error));
		});
	}


	onRawFileChange(path: string): Promise<void> {
		return this.rawConfigEvents(path);
	}

	/** Queues changes whose vault events the runtime dropped, as live events would. */
	restoreDroppedEvents(keys: string[]): void {
		this.queueController.restoreDroppedEvents(keys);
	}

	onFileChange(file: VaultEntry): void {
		if (this.lifecycle.abortSignal.aborted) return;
		this.conflicts.onFileChange(file.path);
		this.queueController.onFileChange(file);
	}

	onFileDelete(file: VaultEntry): void {
		if (this.lifecycle.abortSignal.aborted) return;
		this.conflicts.onFileDelete(file.path);
		this.queueController.onFileDelete(file);
	}


	onFileRename(file: VaultEntry, oldPath: string): void {
		if (this.lifecycle.abortSignal.aborted) return;
		if (!this.ignore.shouldIgnore(oldPath) && !this.ignore.shouldIgnore(file.path)) this.localManifest.recordRename(oldPath, file.path, file.kind);
		this.conflicts.onFileRename(file.path, oldPath);
		this.queueController.onFileRename(file, oldPath);
	}

	/** Syncs every local and remote change. Paths of `held` pending keys, the files left
	 * unchecked in Sync activity, are left alone in both directions and stay pending. */
	async sync(progressCallback?: (current: number, total: number) => void, options: { held?: readonly string[] } = {}): Promise<SyncResult> {
		const held = new Set((options.held ?? []).map(key => decodePendingChange(key).path));
		// A rename's old name is deleted only after its new name uploads, so it waits with it.
		for (const [source, destination] of Object.entries(this.localManifest.getRenameDependencies())) if (held.has(destination)) held.add(source);
		const result = await this.runTrackedWorkflow(() => this.contexts.runStandardSync(held, progressCallback));
		// The cursor may now be past a remote change to a held file. If that file's local change
		// is later discarded, only a full comparison with the server finds the change again.
		if (held.size > 0 && result.success && !this.lifecycle.abortSignal.aborted) {
			await this.requestFullSync().catch(error => logger.warn('Could not save the full sync request:', errorMessage(error)));
		}
		return result;
	}


	private async reconcileFromQueue(queueKeys: string[], selectedOnly = false): Promise<SyncResult> {
		return this.trackWork(() => runReconcileWorkflow({
			...this.contexts.completion,
			apiConfigured: () => this.api.isConfigured(),
			getStatus: () => this.state.status,
			snapshotPendingRevisions: () => this.queueController.snapshotPendingRevisions(),
			reconcilePaths: this.contexts.reconcilePaths,
			settleSynced: (result, revisions) => this.pendingChanges().settleSynced(result, revisions),
			finishInitialSetup: this.contexts.finishInitialSetup,
			onSucceeded: () => this.pruneMarkdownBaseCacheInBackground(),
		}, queueKeys, selectedOnly));
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
		this.lifecycle.abortSignal.throwIfAborted();
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
		if (this.lifecycle.abortSignal.aborted) return;
		this.conflicts.destroy();
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
