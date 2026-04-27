import type { Plugin, TAbstractFile } from 'obsidian';
import { computeTokenHash } from '../cloudflare/infrastructure-shared';
import { getCurrentDeviceName, getCurrentPlatformCode } from '../plugin/deviceInfo';
import { createLogger } from '../plugin/logger';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings, type SyncHistoryEntry, type SyncResult, type SyncState } from '../plugin/types';
import { StatusBarManager } from '../ui/status';
import { SyncApiClient } from './api';
import { isConflictFile, notifyConflicts } from './conflict';
import { SyncEngine } from './engine';
import {
	applyInfrastructureConfigState,
	buildSharedSettings,
	clearSyncConfigurationState,
	deleteManifestFile,
	type ApplyInfrastructureConfigInput,
	type ClearSyncConfigurationOptions,
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
	private progressListeners = new Set<(current: number, total: number) => void>();
	private acceptingEvents = false;
	private initializationRevision = 0;
	private foregroundSyncTimer: ReturnType<typeof setTimeout> | null = null;
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
		return { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };
	}

	getPendingPaths(): string[] {
		return this.syncEngine?.getPendingPaths() ?? [];
	}

	getConflictFiles(): string[] {
		return this.plugin.app.vault.getFiles()
			.filter(f => isConflictFile(f.path))
			.map(f => f.path);
	}

	addStateChangeListener(listener: (state: SyncState) => void): void {
		this.stateChangeListeners.add(listener);
	}

	removeStateChangeListener(listener: (state: SyncState) => void): void {
		this.stateChangeListeners.delete(listener);
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

	async initialize(): Promise<void> {
		logger.info('Initializing sync engine');

		const initializationRevision = ++this.initializationRevision;
		this.acceptingEvents = false;
		this.clearForegroundSyncTimer();

		this.syncEngine?.destroy();
		this.statusBar?.destroy();

		this.apiClient = new SyncApiClient(
			this.settings.workerUrl,
			this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || ''
		);
		this.syncEngine = new SyncEngine(this.plugin, this.apiClient, this.settings);
		const syncEngine = this.syncEngine;

		if (this.settings.showStatusBar) {
			this.statusBar = new StatusBarManager(this.plugin, true, this.onStatusBarClick);
		}

		this.syncEngine.setStateChangeCallback((state: SyncState) => {
			emitStateChange(this.stateChangeListeners, state, (nextState) => {
				this.statusBar?.update(nextState);
			});
		});

		await this.syncEngine.initialize();
		if (this.initializationRevision !== initializationRevision || this.syncEngine !== syncEngine) {
			return;
		}
		await this.registerCurrentDevice();
		this.statusBar?.update(this.syncEngine.getState());

		if (this.settings.syncOnStartup) {
			this.sync()
				.then(result => {
					notifyConflicts(result.conflicts);
				})
				.catch(error => {
					logger.error('Startup sync failed:', error);
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
		this.clearForegroundSyncTimer();
		this.syncEngine?.destroy();
		this.statusBar?.destroy();
		this.syncEngine = null;
		this.apiClient = null;
		this.statusBar = null;
	}

	onRawFileEvent(path: string): void {
		if (!this.acceptingEvents) return;
		this.syncEngine?.onRawFileEvent(path);
	}

	onFileChange(file: TAbstractFile): void {
		if (!this.acceptingEvents) return;
		this.syncEngine?.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		if (!this.acceptingEvents) return;
		this.syncEngine?.onFileDelete(file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
		if (!this.acceptingEvents) return;
		this.syncEngine?.onFileRename(file, oldPath);
	}

	triggerForegroundSync(reason: ForegroundSyncReason): void {
		if (!this.settings.syncOnResume) return;
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

	async applyInfrastructureConfig(config: ApplyInfrastructureConfigInput): Promise<void> {
		applyInfrastructureConfigState(this.settings, this.secretStorage, config);
		await deleteManifestFile(this.plugin);
		resetStoredSyncState(this.settings);
		await this.persistSettings();
		await this.initialize();
	}

	async clearSyncConfiguration(options?: ClearSyncConfigurationOptions): Promise<void> {
		this.destroy();
		await deleteManifestFile(this.plugin);

		resetStoredSyncState(this.settings);
		clearSyncConfigurationState(this.settings, this.secretStorage, options);

		await this.persistSettings();
	}

	updateSyncSettings(): void {
		this.syncEngine?.updateSettings(this.settings);
	}

	async pushSharedSettings(): Promise<void> {
		if (!this.apiClient) return;
		try {
			await this.apiClient.putSharedSettings(buildSharedSettings(this.settings));
		} catch (error) {
			logger.error('Failed to push shared settings:', error);
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
		if (!this.settings.syncOnResume) return;
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

	private async registerCurrentDevice(): Promise<void> {
		if (!this.apiClient) {
			return;
		}

		const authToken = this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN)?.trim();
		if (!authToken) {
			return;
		}

		try {
			await this.apiClient.registerToken(await computeTokenHash(authToken), {
				deviceId: this.settings.deviceId,
				deviceName: getCurrentDeviceName(this.settings.deviceId),
				platform: getCurrentPlatformCode(),
			});
		} catch (error) {
			logger.warn('Failed to register current device metadata:', error);
		}
	}

	private recordSyncResult(type: SyncHistoryEntry['type'], result: SyncResult): void {
		recordSyncHistory(this.settings, type, result);
	}

	private async runSyncOperation(
		type: SyncHistoryEntry['type'],
		operation: (engine: SyncEngine, progress: (current: number, total: number) => void) => Promise<SyncResult>,
		progressCallback?: (current: number, total: number) => void,
		logMessage?: string,
	): Promise<SyncResult> {
		if (!this.syncEngine) return createSyncFailureResult(SYNC_ERROR_MESSAGES.NOT_CONFIGURED);

		if (logMessage) {
			logger.info(logMessage);
		}

		const wrappedCallback = (current: number, total: number) => {
			emitSyncProgress(this.progressListeners, current, total, {
				onStatusBarProgress: (nextCurrent, nextTotal) => {
					this.statusBar?.setSyncProgress(nextCurrent, nextTotal);
				},
				onExternalProgress: progressCallback,
			});
		};
		try {
			const result = await operation(this.syncEngine, wrappedCallback);
			if (type === 'sync') {
				this.lastForegroundSyncAt = Date.now();
			}
			this.recordSyncResult(type, result);
			await this.persistSettings();
			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
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
