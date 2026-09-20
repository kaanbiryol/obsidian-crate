import type { SharedCheckpoint } from '../protocol/history-checkpoints';
import { loadFileHistoryPreview, loadCurrentSyncedPreview } from './file-history-preview';
import type { CrateServerInfo } from '../protocol';
import { createConflictReview } from './conflict-review';
import type { SyncActivityProgress } from './types';
import type { Plugin, TAbstractFile } from 'obsidian';
import { createLogger, errorMessage } from '../plugin/logger';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings } from '../plugin/settings-types';
import type { ConflictRecord, SyncHistoryEntry, SyncResult, SyncState } from './types';
import type { FileVersionQuery, FileVersionsPage, RemoteFileVersion } from '../protocol/sync-types';
import { StatusBarManager } from '../ui/status';
import { SyncApiClient } from './api';
import { isConflictFile, notifyConflicts } from './conflict';
import { SyncEngine } from './engine';
import { normalizeWorkerUrl, requireNormalizedWorkerUrl } from './worker-url';
import { buildDiagnosticExport } from './diagnostic-export';
import {
	applyInfrastructureConfigState,
	buildSharedSettings,
	clearSyncConfigurationState,
	deleteManifestFile,
	type ApplyInfrastructureConfigInput,
} from './runtime-config';
import { recordSyncHistory, resetStoredSyncState } from './runtime-history';
import { emitStateChange, emitSyncProgress } from './runtime-listeners';
import { createSyncFailureResult, mergeSyncResults, SYNC_ERROR_MESSAGES } from './sync-result';

const logger = createLogger('SyncRuntime');
export const FOREGROUND_SYNC_DEBOUNCE_MS = 1_000;
export const FOREGROUND_SYNC_COOLDOWN_MS = 30_000;

export type ForegroundSyncReason = 'focus' | 'visible' | 'online';

export class SyncRuntime {
	private syncEngine: SyncEngine | null = null;
	private apiClient: SyncApiClient | null = null;
	private statusBar: StatusBarManager | null = null;
	private stateChangeListeners = new Set<(state: SyncState) => void>();
	private activityProgress: SyncActivityProgress | null = null;
	private progressListeners = new Set<(current: number, total: number) => void>();
	private acceptingEvents = false;
	private initializationError: string | null = null;
	private initializationRevision = 0;
	private stoppingWork: Promise<void> = Promise.resolve();
	private stopSyncTask: Promise<void> | null = null;
	private configurationChain: Promise<void> = Promise.resolve();
	private startupSyncTask: Promise<boolean> = Promise.resolve(false);
	private foregroundSyncTimer: ReturnType<typeof setTimeout> | null = null;

	async loadCurrentSyncedPreview(path: string) {
		const api = this.apiClient;
		if (!api) throw new Error('Sync is not configured');
		const preview = await loadCurrentSyncedPreview(api, path);
		if (api !== this.apiClient) throw new Error('Sync configuration changed. Reopen file history.');
		return preview;
	}

	async loadFileHistoryPreview(version: RemoteFileVersion) {
		const api = this.apiClient;
		if (!api) throw new Error('Sync is not configured');
		const preview = await loadFileHistoryPreview(this.plugin.app.vault.adapter, api, version);
		if (api !== this.apiClient) throw new Error('Sync configuration changed. Reopen file history.');
		return preview;
	}

	async listRecentFileVersions(query: FileVersionQuery = {}): Promise<FileVersionsPage> {
		if (!this.apiClient) throw new Error('Sync is not configured');
		return this.apiClient.listFileVersions(query);
	}

	async restoreRecentFileVersion(version: RemoteFileVersion): Promise<SyncResult> {
		if (!this.apiClient) throw new Error('Sync is not configured');
		const api = this.apiClient;
		await api.restoreFileVersion(version);
		if (api !== this.apiClient) throw new DOMException('Sync configuration changed during restore', 'AbortError');
		const result = await this.sync();
		if (result.success) await api.finishRestore(version.storage_key);
		return result;
	}
	getPendingRestores(): RemoteFileVersion[] { return this.apiClient?.getPendingRestores() ?? []; }
	private lastForegroundSyncAt: number | null = null;

	private onStatusBarClick: (() => void) | undefined;

	constructor(
		private plugin: Plugin,
		private settings: CrateSettings,
		private secretStorage: SecretStorageService,
		private persistSettings: (update?: Partial<CrateSettings>) => Promise<void>,
    private prepareReminderScope?: () => Promise<void>,
	) {}

	setStatusBarClickHandler(handler: () => void): void {
		this.onStatusBarClick = handler;
	}

	getState(): SyncState {
		if (this.syncEngine) {
			return this.syncEngine.getState();
		}
		return { status: this.initializationError ? 'error' : 'idle', lastSync: null, lastError: this.initializationError, pendingChanges: 0, conflictCount: 0 };
	}

	getPendingPaths(): string[] {
		return this.syncEngine?.getPendingPaths() ?? [];
	}

	async loadPendingDiff(path: string, deleted: boolean) {
		const engine = this.syncEngine;
		if (!engine) throw new Error('Sync is not initialized');
		const pendingPath = deleted ? `delete:${path}` : path;
		const verify = () => {
			if (engine !== this.syncEngine || this.getState().status === 'syncing' || !this.getPendingPaths().includes(pendingPath)) {
				throw new Error('Pending changes were updated. Reopen the file to refresh its preview.');
			}
		};
		verify();
		const preview = await engine.loadPendingDiff(path, deleted);
		verify();
		return preview;
	}

	private versionInfo?: { client: SyncApiClient; info: CrateServerInfo };
	private versionRequest?: { client: SyncApiClient; promise: Promise<CrateServerInfo> };

	async getVersionInfo(): Promise<CrateServerInfo> {
		const client = this.apiClient;
		if (!client) throw new Error('Not connected');
		if (this.versionRequest?.client === client) return this.versionRequest.promise;
		this.versionInfo = undefined;
		const promise = client.getServerInfo().then(info => {
			if (this.apiClient !== client) throw new Error('Server changed');
			this.versionInfo = { client, info };
			return info;
		});
		this.versionRequest = { client, promise };
		try { return await promise; }
		finally { if (this.versionRequest?.promise === promise) this.versionRequest = undefined; }
	}

	exportDiagnostics(): string {
		return buildDiagnosticExport(this.settings, this.getState(), this.plugin.manifest.version, this.apiClient?.getRequestDiagnostics(), this.versionInfo?.client === this.apiClient ? this.versionInfo?.info : undefined);
	}

	async previewIgnoredRemoteFiles(): Promise<string[]> {
		if (!this.syncEngine) throw new Error('Sync is not configured');
		return this.syncEngine.previewIgnoredRemoteFiles();
	}

	async purgeIgnoredRemoteFiles(): Promise<{ deleted: string[]; errors: string[] }> {
		if (!this.syncEngine) throw new Error('Sync is not configured');
		return this.syncEngine.purgeIgnoredRemoteFiles();
	}

	async createConflictReview(record: ConflictRecord) {
		if (!this.syncEngine || !this.getActiveConflicts().some(item => item.conflictPath === record.conflictPath)) throw new Error('Conflict is no longer active');
		const engine = this.syncEngine;
		const review = await createConflictReview(this.plugin.app, this.plugin.manifest.dir!, record, () => this.syncEngine !== engine, () => engine.markConflictResolved(record.conflictPath));
		return { ...review, resolve: (choice: import('./conflict-review').ConflictChoice, editedText?: string) => engine.runConflictResolution(() => review.resolve(choice, editedText)) };
	}

	getActiveConflicts(): ConflictRecord[] {
		return this.syncEngine?.getActiveConflicts() ?? [];
	}

	addStateChangeListener(listener: (state: SyncState) => void): void {
		this.stateChangeListeners.add(listener);
	}

	removeStateChangeListener(listener: (state: SyncState) => void): void {
		this.stateChangeListeners.delete(listener);
	}

	getActivityProgress(): SyncActivityProgress | null {
		return this.activityProgress ? { ...this.activityProgress } : null;
	}

	addProgressListener(listener: (current: number, total: number) => void): void {
		this.progressListeners.add(listener);
	}

	removeProgressListener(listener: (current: number, total: number) => void): void {
		this.progressListeners.delete(listener);
	}

	isConfigured(): boolean {
		return this.settings.workerUrl.length > 0 && this.secretStorage.has(SECRET_KEYS.AUTH_TOKEN);
	}

	getApiClient(): SyncApiClient | null {
		return this.apiClient;
	}

	waitForStartupSync(): Promise<boolean> {
		return this.startupSyncTask;
	}

	async initialize(options: { skipStartupSync?: boolean } = {}): Promise<void> {
		logger.info('Initializing sync engine');

		const initializationRevision = ++this.initializationRevision;
		this.initializationError = null;
		this.acceptingEvents = false;
		this.startupSyncTask = Promise.resolve(false);
		this.clearForegroundSyncTimer();

		this.stopEngine();
		this.statusBar?.destroy();

		await this.stoppingWork;
		if (this.initializationRevision !== initializationRevision) return;

		this.apiClient = new SyncApiClient(
			this.settings.workerUrl,
			this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || ''
		);
		this.syncEngine = new SyncEngine(this.plugin, this.apiClient, this.settings);
		const syncEngine = this.syncEngine;
		syncEngine.setAutomaticSyncResultCallback(result => this.recordAutomaticSyncResult(syncEngine, result));
		syncEngine.setReminderScopePreparation(this.prepareReminderScope);

		this.statusBar = new StatusBarManager(this.plugin, true, this.onStatusBarClick);

		this.syncEngine.setStateChangeCallback((state: SyncState) => {
			if (this.syncEngine !== syncEngine || this.initializationRevision !== initializationRevision) return;
			emitStateChange(this.stateChangeListeners, state, (nextState) => {
				this.statusBar?.update(nextState);
			});
		});

		try {
			await syncEngine.initialize();
		} catch (error) {
			if (this.initializationRevision !== initializationRevision || this.syncEngine !== syncEngine) return;
			this.initializationError = errorMessage(error);
			this.stopEngine();
			this.apiClient = null;
			this.statusBar?.update(this.getState());
			throw error;
		}
		if (this.initializationRevision !== initializationRevision || this.syncEngine !== syncEngine) {
			return;
		}
		this.statusBar?.update(this.syncEngine.getState());

		if (this.settings.automaticSync && !options.skipStartupSync) {
			this.startupSyncTask = this.sync()
				.then(async result => {
					notifyConflicts(result.conflicts);
					if (
						result.success
						&& this.initializationRevision === initializationRevision
						&& this.syncEngine === syncEngine
					) {
						// Resume event capture before probing so edits made after the
						// startup operation cannot fall into a second blind window.
						this.acceptingEvents = true;
						if (await syncEngine.hasUnsyncedLocalChanges() && this.settings.automaticSync) {
							logger.info('Local changes detected after startup sync; running a recovery pass');
							const recoveryResult = await this.sync();
							notifyConflicts(recoveryResult.conflicts);
						}
					}
					return true;
				})
				.catch(error => {
					logger.error('Startup sync failed:', error);
					return true;
				})
				.finally(() => {
					if (this.initializationRevision === initializationRevision && this.syncEngine === syncEngine) {
						this.acceptingEvents = true;
					}
				});
			return;
		}

		this.acceptingEvents = true;
	}

	destroy(): void {
		this.initializationRevision++;
		this.acceptingEvents = false;
		this.startupSyncTask = Promise.resolve(false);
		this.clearForegroundSyncTimer();
		this.stopEngine();
		this.statusBar?.destroy();
		this.syncEngine = null;
		this.apiClient = null;
		this.statusBar = null;
	}

	stopSync(): Promise<void> {
		if (this.stopSyncTask) return this.stopSyncTask;
		// Abort immediately, before waiting for disk work or settings persistence.
		this.settings.automaticSync = false;
		this.destroy();
		const revision = this.initializationRevision;
		this.activityProgress = null;
		this.stopSyncTask = this.changeConfiguration(async () => {
			await this.stoppingWork;
			this.assertTransitionActive(revision);
			await this.persistSettings({ automaticSync: false });
			this.assertTransitionActive(revision);
			if (this.isConfigured()) await this.initialize({ skipStartupSync: true });
		}).finally(() => {
			this.stopSyncTask = null;
			this.emitCurrentState();
		});
		return this.stopSyncTask;
	}

	private stopEngine(): void {
		const engine = this.syncEngine;
		this.syncEngine = null;
		engine?.destroy();
		this.stoppingWork = Promise.allSettled([this.stoppingWork, engine?.waitForIdle()]).then(() => {});
	}

	private changeConfiguration(operation: () => Promise<void>): Promise<void> {
		const task = this.configurationChain.then(operation);
		this.configurationChain = task.catch(() => {});
		return task;
	}

	private assertTransitionActive(revision: number, signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.initializationRevision !== revision) throw new DOMException('Sync configuration changed during reset', 'AbortError');
	}

	onRawFileChange(path: string): void {
		if (this.plugin.app.workspace.layoutReady === false || !this.acceptingEvents) return;
		void this.syncEngine?.onRawFileChange(path);
	}

	onFileChange(file: TAbstractFile): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path)) return;
		this.syncEngine?.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path)) return;
		this.syncEngine?.onFileDelete(file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (this.plugin.app.workspace.layoutReady === false) return;
		if (!this.acceptingEvents && !isConflictFile(file.path) && !isConflictFile(oldPath)) return;
		this.syncEngine?.onFileRename(file, oldPath);
	}

	triggerForegroundSync(reason: ForegroundSyncReason): void {
		if (!this.settings.automaticSync) return;
		if (!this.acceptingEvents || !this.isConfigured() || !this.syncEngine) return;
		if (this.syncEngine.getState().status === 'syncing') return;
		if (this.foregroundSyncTimer) return;

		if (this.isForegroundSyncOnCooldown()) {
			return;
		}

		this.foregroundSyncTimer = setTimeout(() => {
			this.foregroundSyncTimer = null;
			void this.runForegroundSync(reason);
		}, FOREGROUND_SYNC_DEBOUNCE_MS);
	}

	async applyInfrastructureConfig(config: ApplyInfrastructureConfigInput, signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(async () => {
			signal?.throwIfAborted();
			const workerUrl = requireNormalizedWorkerUrl(config.workerUrl);
			if (!config.authToken.trim()) throw new Error('Auth token is required');
			const changingServer = workerUrl !== normalizeWorkerUrl(this.settings.workerUrl);
			this.destroy();
			const revision = this.initializationRevision;
			await this.stoppingWork;
			this.assertTransitionActive(revision, signal);
			if (changingServer) await deleteManifestFile(this.plugin, signal);
			this.assertTransitionActive(revision, signal);
			applyInfrastructureConfigState(this.settings, this.secretStorage, { ...config, workerUrl });
			if (changingServer) resetStoredSyncState(this.settings);
			await this.persistSettings();
			this.assertTransitionActive(revision, signal);
			await this.initialize({ skipStartupSync: true });
		});
	}

	async clearSyncConfiguration(signal?: AbortSignal): Promise<void> {
		return this.changeConfiguration(async () => {
			signal?.throwIfAborted();
			const api = this.apiClient;
			this.destroy();
			const revision = this.initializationRevision;
			await this.stoppingWork;
			this.assertTransitionActive(revision, signal);
			try {
				// The stopped engine aborted this client. Revocation is a separate,
				// explicitly requested operation after all old work has settled.
				api?.setAbortSignal(signal ?? new AbortController().signal);
				await api?.revokeCurrentToken();
			} catch (error) {
				logger.warn('Failed to revoke the current device credential:', error);
			}
			this.assertTransitionActive(revision, signal);
			await deleteManifestFile(this.plugin, signal);
			this.assertTransitionActive(revision, signal);
			resetStoredSyncState(this.settings);
			clearSyncConfigurationState(this.settings, this.secretStorage);
			await this.persistSettings();
		});
	}

	updateSyncSettings(): void {
		this.syncEngine?.updateSettings(this.settings);
	}

	async pushSharedSettingsBestEffort(): Promise<boolean> {
		if (!this.apiClient) return false;
		try {
			await this.apiClient.putSharedSettings(buildSharedSettings(this.settings));
			return true;
		} catch (error) {
			logger.error('Failed to push shared settings:', error);
			return false;
		}
	}

	async testConnection(): Promise<{ success: boolean; error?: string }> {
		if (!this.apiClient) {
			return { success: false, error: 'Not configured' };
		}
		return this.apiClient.testConnection();
	}

	private clearForegroundSyncTimer(): void {
		if (this.foregroundSyncTimer) {
			clearTimeout(this.foregroundSyncTimer);
			this.foregroundSyncTimer = null;
		}
	}

	private isForegroundSyncOnCooldown(): boolean {
		return this.lastForegroundSyncAt !== null
			&& Date.now() - this.lastForegroundSyncAt < FOREGROUND_SYNC_COOLDOWN_MS;
	}

	private async runForegroundSync(reason: ForegroundSyncReason): Promise<void> {
		if (!this.settings.automaticSync) return;
		if (!this.acceptingEvents || !this.isConfigured() || !this.syncEngine) return;
		if (this.syncEngine.getState().status === 'syncing') return;
		if (this.isForegroundSyncOnCooldown()) return;

		this.lastForegroundSyncAt = Date.now();
		logger.info(`Foreground sync triggered: ${reason}`);

		try {
			const result = await this.sync();
			notifyConflicts(result.conflicts);
		} catch (error) {
			logger.warn('Foreground sync failed:', error);
		}
	}

	private async recordSyncResult(type: SyncHistoryEntry['type'], result: SyncResult): Promise<void> {
		recordSyncHistory(this.settings, type, result);
		const latest = this.settings.syncHistory[0];
		if (latest && this.syncEngine) latest.timings = this.syncEngine.getTimings?.();
		if (latest && this.apiClient) latest.requestDiagnostics = this.apiClient.getRequestDiagnostics();
		if (latest && result.success && !result.conflicts.length && this.syncEngine) {
			try {
                const shared = await this.syncEngine.saveSharedHistoryCheckpoint?.();
                if (shared) latest.sharedCheckpoint = shared.id;
                else latest.historyCheckpoint = await this.syncEngine.saveHistoryCheckpoint?.();
            }
			catch (error) { logger.warn('Could not save the history checkpoint:', errorMessage(error)); }
		}
	}

	private emitCurrentState(): void {
		if (!this.syncEngine) return;
		emitStateChange(this.stateChangeListeners, this.syncEngine.getState(), (nextState) => {
			this.statusBar?.update(nextState);
		});
	}

	private async recordAutomaticSyncResult(engine: SyncEngine, result: SyncResult): Promise<void> {
		if (this.syncEngine !== engine) return;
		const state = engine.getState();
		if (result.success && state.lastSync) {
			this.settings.lastSync = state.lastSync;
		}
		await this.recordSyncResult('sync', result);
		this.emitCurrentState();
		try {
			await this.persistSettings();
		} catch (error) {
			logger.error('Failed to persist automatic sync activity:', error);
		}
	}

	private async runSyncOperation(
		type: SyncHistoryEntry['type'],
		operation: (engine: SyncEngine, progress: (current: number, total: number) => void) => Promise<SyncResult>,
		progressCallback?: (current: number, total: number) => void,
		logMessage?: string,
	): Promise<SyncResult> {
		if (this.stopSyncTask) return createSyncFailureResult('Sync is stopping. Try again when it finishes.');
		if (!this.syncEngine) return createSyncFailureResult(SYNC_ERROR_MESSAGES.NOT_CONFIGURED);

		const engine = this.syncEngine;
		if (logMessage) {
			logger.info(logMessage);
		}

		const active = { type, current: 0, total: 0 };
		this.activityProgress = active;
		emitSyncProgress(this.progressListeners, 0, 0);
		const wrappedCallback = (current: number, total: number) => {
			if (this.syncEngine !== engine) return;
			Object.assign(active, { current, total });
			emitSyncProgress(this.progressListeners, current, total, {
				onStatusBarProgress: (nextCurrent, nextTotal) => {
					this.statusBar?.setSyncProgress(nextCurrent, nextTotal);
				},
				onExternalProgress: progressCallback,
			});
		};
		try {
			const result = await operation(engine, wrappedCallback);
			if (this.syncEngine !== engine) return result;
			if (type === 'sync') {
				this.lastForegroundSyncAt = Date.now();
			}
			await this.recordSyncResult(type, result);
			await this.persistSettings();
			return result;
		} finally {
			if (this.activityProgress === active) this.activityProgress = null;
			if (this.syncEngine === engine) {
				emitSyncProgress(this.progressListeners, 0, 0);
				this.statusBar?.clearSyncProgress();
			}
		}
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runSyncOperation(
			'sync',
			(syncEngine, wrappedCallback) => syncEngine.sync(wrappedCallback),
			progressCallback,
			'Sync triggered',
		);
	}

    async syncSelected(keys: string[]): Promise<SyncResult> {
        return this.runSyncOperation('sync', engine => engine.syncSelected(keys));
    }

    async createPendingDiscard(keys: string[]) {
        if (!this.syncEngine) throw new Error('Sync is not configured.');
        return this.syncEngine.createPendingDiscard(keys);
    }

    async listSharedCheckpoints(): Promise<SharedCheckpoint[]> {
        const api = this.apiClient;
        if (!api) throw new Error('Sync is not configured.');
        const checkpoints = await api.sharedHistory.list();
        if (api !== this.apiClient) throw new Error('Sync connection changed. Reopen history.');
        return checkpoints;
    }

    async createHistoryRestore(entry: SyncHistoryEntry) {
        const engine = this.syncEngine;
        if (!engine || !entry.sharedCheckpoint && (!entry.historyCheckpoint || !this.settings.syncHistory.some(saved => saved.timestamp === entry.timestamp && saved.type === entry.type && saved.historyCheckpoint === entry.historyCheckpoint))) throw new Error('This history entry has no complete vault checkpoint.');
        let automaticSync = false;
        const verify = () => {
            if (this.syncEngine !== engine) throw new Error('Sync connection changed. Reopen history.');
        };
        const review = await engine.createHistoryRestore(entry.sharedCheckpoint ?? entry.historyCheckpoint!, async () => {
            verify();
            automaticSync = this.settings.automaticSync;
            // Persist the pause before changing files, including across a crash.
            this.settings.automaticSync = false;
            this.clearForegroundSyncTimer();
            engine.updateSettings(this.settings);
            await this.persistSettings({ automaticSync: false });
            verify();
        }, Boolean(entry.sharedCheckpoint));
        verify();
        return { items: review.items, unchangedCount: review.unchangedCount, restore: async () => {
            verify();
            await review.restore();
            verify();
            if (!review.items.length) return;
            const result = await this.runSyncOperation('sync', async (current, progress) => {
                const removed = new Set(review.items.filter(item => item.action === 'remove').map(item => item.path));
                const keys = removed.size ? current.getPendingPaths().filter(key => removed.has(key.startsWith('delete:') ? key.slice(7) : key)) : [];
                // The verified local recovery copies allow explicit removals to
                // settle first, freeing paths for historical file/folder renames.
                const deletions = keys.length ? await current.syncSelected(keys) : undefined;
                if (deletions && (!deletions.success || deletions.conflicts.length)) return deletions;
                const synced = await current.sync(progress);
                if (deletions) mergeSyncResults(synced, deletions);
                return synced;
            });
            verify();
            if (!result.success || result.conflicts.length) throw new Error('Restore needs attention during sync. Automatic sync is off; review Pending and Conflicts before continuing.');
            await review.verifySynced();
            verify();
            try {
                await this.persistSettings({ automaticSync });
            } catch (error) {
                this.settings.automaticSync = false;
                engine.updateSettings(this.settings);
                throw error;
            }
            verify();
            this.settings.automaticSync = automaticSync;
            engine.updateSettings(this.settings);
        } };
    }

	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runSyncOperation(
			'initial',
			(syncEngine, wrappedCallback) => syncEngine.initialSync(wrappedCallback),
			progressCallback,
		);
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		return this.runSyncOperation(
			'force',
			(syncEngine, wrappedCallback) => syncEngine.forceFullSync(wrappedCallback),
			progressCallback,
		);
	}
}
