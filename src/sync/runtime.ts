import type { Plugin, TAbstractFile } from 'obsidian';
import { createLogger } from '../plugin/logger';
import type { SecretStorageService } from '../plugin/secret-storage';
import { MAX_SYNC_HISTORY, MAX_SYNC_HISTORY_PATHS, SECRET_KEYS, type CrateSettings, type SharedSettings, type SyncHistoryEntry, type SyncResult, type SyncState } from '../plugin/types';
import { StatusBarManager } from '../ui/status';
import { SyncApiClient } from './api';
import { isConflictFile, notifyConflicts } from './conflict';
import { SyncEngine } from './engine';
import { guardSyncConfigured } from './sync-guards';
import { requireNormalizedWorkerUrl } from './worker-url';

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
			return;
		}

		this.acceptingEvents = true;
	}

	destroy(): void {
		this.acceptingEvents = false;
		this.syncEngine?.destroy();
		this.statusBar?.destroy();
		this.syncEngine = null;
		this.apiClient = null;
		this.statusBar = null;
	}

	private async deleteManifestFile(): Promise<void> {
		const path = `${this.plugin.manifest.dir}/file-manifest.json`;
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (await adapter.exists(path)) {
				await adapter.remove(path);
			}
		} catch { /* best effort */ }
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

	async applyInfrastructureConfig(config: ApplyInfrastructureConfigInput): Promise<void> {
		const authToken = config.authToken.trim();
		if (!authToken) {
			throw new Error('Auth token is required');
		}

		this.settings.workerUrl = requireNormalizedWorkerUrl(config.workerUrl);
		this.settings.workerName = config.workerName.trim();
		this.settings.bucketName = config.bucketName.trim();
		this.settings.databaseId = config.databaseId.trim();
		this.settings.cloudflareAccountId = config.accountId?.trim() || '';
		this.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, authToken);
		await this.deleteManifestFile();
		this.settings.lastSeq = 0;
		this.resetSyncState();
		await this.persistSettings();
		await this.initialize();
	}

	async clearSyncConfiguration(options?: ClearSyncConfigurationOptions): Promise<void> {
		this.destroy();
		await this.deleteManifestFile();

		this.resetSyncState();
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

	async pushSharedSettings(): Promise<void> {
		if (!this.apiClient) return;
		const shared: SharedSettings = {
			ignorePatterns: this.settings.ignorePatterns,
			syncOnStartup: this.settings.syncOnStartup,
			syncInterval: this.settings.syncInterval,
			showStatusBar: this.settings.showStatusBar,
			pushEnabled: this.settings.pushEnabled,
		};
		try {
			await this.apiClient.putSharedSettings(shared);
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
			uploadedPaths: this.limitHistoryPaths(result.uploadedPaths),
			downloadedPaths: this.limitHistoryPaths(result.downloadedPaths),
			deletedPaths: this.limitHistoryPaths(result.deletedPaths),
		};
		this.settings.syncHistory.unshift(entry);
		if (this.settings.syncHistory.length > MAX_SYNC_HISTORY) {
			this.settings.syncHistory.length = MAX_SYNC_HISTORY;
		}
	}

	private resetSyncState(): void {
		this.settings.lastSeq = 0;
		this.settings.lastSync = null;
		this.settings.syncHistory = [];
	}

	private limitHistoryPaths(paths: string[]): string[] {
		return paths.slice(0, MAX_SYNC_HISTORY_PATHS);
	}

	private getConfiguredSyncEngine(): SyncEngine | SyncResult {
		const guardResult = guardSyncConfigured(this.syncEngine !== null);
		if (guardResult) {
			return guardResult;
		}
		return this.syncEngine as SyncEngine;
	}

	private createProgressReporter(progressCallback?: (current: number, total: number) => void) {
		return (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
			for (const listener of this.progressListeners) {
				listener(current, total);
			}
		};
	}

	private async runSyncOperation(
		type: SyncHistoryEntry['type'],
		operation: (engine: SyncEngine, progress: (current: number, total: number) => void) => Promise<SyncResult>,
		progressCallback?: (current: number, total: number) => void,
		logMessage?: string,
	): Promise<SyncResult> {
		const syncEngineOrGuard = this.getConfiguredSyncEngine();
		if ('success' in syncEngineOrGuard) {
			return syncEngineOrGuard;
		}
		const syncEngine = syncEngineOrGuard;

		if (logMessage) {
			logger.info(logMessage);
		}

		const wrappedCallback = this.createProgressReporter(progressCallback);
		try {
			const result = await operation(syncEngine, wrappedCallback);
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
