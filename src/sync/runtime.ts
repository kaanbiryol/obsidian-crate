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
import { createSyncFailureResult, SYNC_ERROR_MESSAGES } from './sync-result';

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
	private configurationChain: Promise<void> = Promise.resolve();
	private startupSyncTask: Promise<boolean> = Promise.resolve(false);
	private foregroundSyncTimer: ReturnType<typeof setTimeout> | null = null;

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
		private persistSettings: () => Promise<void>
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

	exportDiagnostics(): string {
		return buildDiagnosticExport(this.settings, this.getState(), this.plugin.manifest.version, this.apiClient?.getRequestDiagnostics());
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

		if (this.settings.showStatusBar) {
			this.statusBar = new StatusBarManager(this.plugin, true, this.onStatusBarClick);
		}

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

	updateStatusBar(enabled: boolean): void {
		if (enabled && !this.statusBar) {
			this.statusBar = new StatusBarManager(this.plugin, true, this.onStatusBarClick);
			if (this.syncEngine) {
				this.statusBar.update(this.syncEngine.getState());
			}
		} else if (!enabled && this.statusBar) {
			this.statusBar.destroy();
			this.statusBar = null;
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

	private recordSyncResult(type: SyncHistoryEntry['type'], result: SyncResult): void {
		recordSyncHistory(this.settings, type, result);
		const latest = this.settings.syncHistory[0];
		if (latest && this.apiClient) latest.requestDiagnostics = this.apiClient.getRequestDiagnostics();
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
		this.recordSyncResult('sync', result);
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
			this.recordSyncResult(type, result);
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
