import type { Plugin, TAbstractFile } from 'obsidian';
import { createLogger } from '../logger';
import type { SecretStorageService } from '../secret-storage';
import { MAX_SYNC_HISTORY, SECRET_KEYS, type CrateSettings, type SyncHistoryEntry, type SyncResult, type SyncState } from '../types';
import { StatusBarManager } from '../ui/status';
import { SyncApiClient } from './api';
import { notifyConflicts } from './conflict';
import { SyncEngine } from './engine';
import { guardSyncConfigured } from './sync-guards';

const logger = createLogger('SyncRuntime');

interface ApplyInfrastructureConfigInput {
	workerUrl: string;
	authToken: string;
	workerName: string;
	bucketName: string;
	databaseId: string;
	accountId?: string;
}

interface ClearSyncConfigurationOptions {
	clearCloudflareCredentials?: boolean;
}

export class SyncRuntime {
	private syncEngine: SyncEngine | null = null;
	private apiClient: SyncApiClient | null = null;
	private statusBar: StatusBarManager | null = null;
	private stateChangeListeners = new Set<(state: SyncState) => void>();
	private progressListeners = new Set<(current: number, total: number) => void>();
	private acceptingEvents = false;

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

		this.acceptingEvents = false;

		this.syncEngine?.destroy();
		this.statusBar?.destroy();

		this.apiClient = new SyncApiClient(
			this.settings.workerUrl,
			this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || ''
		);
		this.syncEngine = new SyncEngine(this.plugin, this.apiClient, this.settings);

		if (this.settings.showStatusBar) {
			this.statusBar = new StatusBarManager(this.plugin, true, this.onStatusBarClick);
		}

		this.syncEngine.setStateChangeCallback((state: SyncState) => {
			this.statusBar?.update(state);
			for (const listener of this.stateChangeListeners) {
				listener(state);
			}
		});

		await this.syncEngine.initialize();
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
					this.acceptingEvents = true;
				});
		} else {
			this.acceptingEvents = true;
		}
	}

	destroy(): void {
		this.syncEngine?.destroy();
		this.statusBar?.destroy();
		this.syncEngine = null;
		this.apiClient = null;
		this.statusBar = null;
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

	async applyInfrastructureConfig(config: ApplyInfrastructureConfigInput): Promise<void> {
		this.settings.workerUrl = config.workerUrl.trim();
		this.settings.workerName = config.workerName.trim();
		this.settings.bucketName = config.bucketName.trim();
		this.settings.databaseId = config.databaseId.trim();
		if (config.accountId !== undefined) {
			this.settings.cloudflareAccountId = config.accountId.trim();
		}
		this.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, config.authToken.trim());
		await this.persistSettings();
		await this.initialize();
	}

	async clearSyncConfiguration(options?: ClearSyncConfigurationOptions): Promise<void> {
		this.destroy();

		this.settings.workerUrl = '';
		this.settings.workerName = '';
		this.settings.bucketName = '';
		this.settings.databaseId = '';
		this.secretStorage.delete(SECRET_KEYS.AUTH_TOKEN);

		if (options?.clearCloudflareCredentials) {
			this.settings.cloudflareAccountId = '';
			this.settings.cloudflareTokenExpiresAt = null;
			this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
			this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN);
		}

		await this.persistSettings();
	}

	updateSyncSettings(): void {
		this.syncEngine?.updateSettings(this.settings);
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

	private recordSyncResult(type: SyncHistoryEntry['type'], result: SyncResult): void {
		const entry: SyncHistoryEntry = {
			timestamp: new Date().toISOString(),
			type,
			success: result.success,
			uploaded: result.uploaded,
			downloaded: result.downloaded,
			deleted: result.deleted,
			errorCount: result.errors.length,
			conflictCount: result.conflicts.length,
			uploadedPaths: result.uploadedPaths,
			downloadedPaths: result.downloadedPaths,
			deletedPaths: result.deletedPaths,
		};
		this.settings.syncHistory.unshift(entry);
		if (this.settings.syncHistory.length > MAX_SYNC_HISTORY) {
			this.settings.syncHistory.length = MAX_SYNC_HISTORY;
		}
	}

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const guardResult = guardSyncConfigured(this.syncEngine !== null);
		if (guardResult) {
			return guardResult;
		}
		const syncEngine = this.syncEngine as SyncEngine;

		logger.info('Sync triggered');
		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
			for (const listener of this.progressListeners) {
				listener(current, total);
			}
		};

		try {
			const result = await syncEngine.sync(wrappedCallback);
			this.recordSyncResult('sync', result);
			await this.persistSettings();
			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
	}

	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const guardResult = guardSyncConfigured(this.syncEngine !== null);
		if (guardResult) {
			return guardResult;
		}
		const syncEngine = this.syncEngine as SyncEngine;

		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
			for (const listener of this.progressListeners) {
				listener(current, total);
			}
		};

		try {
			const result = await syncEngine.initialSync(wrappedCallback);
			this.recordSyncResult('initial', result);
			await this.persistSettings();
			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		const guardResult = guardSyncConfigured(this.syncEngine !== null);
		if (guardResult) {
			return guardResult;
		}
		const syncEngine = this.syncEngine as SyncEngine;

		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
			for (const listener of this.progressListeners) {
				listener(current, total);
			}
		};

		try {
			const result = await syncEngine.forceFullSync(wrappedCallback);
			this.recordSyncResult('force', result);
			await this.persistSettings();
			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
	}
}
