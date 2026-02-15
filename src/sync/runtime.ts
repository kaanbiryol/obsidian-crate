import type { Plugin, TAbstractFile } from 'obsidian';
import { createLogger } from '../logger';
import type { SecretStorageService } from '../secret-storage';
import { SECRET_KEYS, type CrateSettings, type SyncResult, type SyncState } from '../types';
import { StatusBarManager } from '../ui/status';
import { SyncApiClient } from './api';
import { SyncEngine } from './engine';

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

	constructor(
		private plugin: Plugin,
		private settings: CrateSettings,
		private secretStorage: SecretStorageService,
		private persistSettings: () => Promise<void>
	) {}

	isConfigured(): boolean {
		return this.settings.workerUrl.length > 0 && this.secretStorage.has(SECRET_KEYS.AUTH_TOKEN);
	}

	getApiClient(): SyncApiClient | null {
		return this.apiClient;
	}

	async initialize(): Promise<void> {
		logger.info('Initializing sync engine');

		this.syncEngine?.destroy();
		this.statusBar?.destroy();

		this.apiClient = new SyncApiClient(
			this.settings.workerUrl,
			this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || ''
		);
		this.syncEngine = new SyncEngine(this.plugin, this.apiClient, this.settings);

		if (this.settings.showStatusBar) {
			this.statusBar = new StatusBarManager(this.plugin, true);
		}

		this.syncEngine.setStateChangeCallback((state: SyncState) => {
			this.statusBar?.update(state);
		});

		await this.syncEngine.initialize();
		this.statusBar?.update(this.syncEngine.getState());

		if (this.settings.syncOnStartup) {
			void this.sync();
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
		this.syncEngine?.onFileChange(file);
	}

	onFileDelete(file: TAbstractFile): void {
		this.syncEngine?.onFileDelete(file);
	}

	onFileRename(file: TAbstractFile, oldPath: string): void {
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
			this.statusBar = new StatusBarManager(this.plugin, true);
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

	async sync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		if (!this.syncEngine) {
			return this.notConfiguredResult();
		}

		logger.info('Sync triggered');
		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
		};

		try {
			const result = await this.syncEngine.sync(wrappedCallback);
			await this.persistSettings();
			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
	}

	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		if (!this.syncEngine) {
			return this.notConfiguredResult();
		}

		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
		};

		try {
			const result = await this.syncEngine.initialSync(wrappedCallback);
			await this.persistSettings();
			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
	}

	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		if (!this.syncEngine) {
			return this.notConfiguredResult();
		}

		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
		};

		try {
			const result = await this.syncEngine.forceFullSync(wrappedCallback);
			await this.persistSettings();
			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
	}

	private notConfiguredResult(): SyncResult {
		return {
			success: false,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [],
			errors: ['Not configured'],
		};
	}
}
