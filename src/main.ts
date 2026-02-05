/**
 * Obsidian Crate - Sync your vault to Cloudflare R2
 */

import { Plugin, Notice, TAbstractFile } from 'obsidian';
import { CrateSettings, DEFAULT_SETTINGS, SECRET_KEYS } from './settings';
import { SyncEngine } from './sync/engine';
import { SyncApiClient } from './sync/api';
import { SecretStorageService } from './secret-storage';
import { StatusBarManager } from './ui/status';
import { CrateSettingTab } from './ui/settings-tab';
import { createLogger } from './logger';
import type { SyncResult, SyncState } from './types';

const logger = createLogger('Plugin');

export default class CratePlugin extends Plugin {
	settings: CrateSettings;
	private syncEngine: SyncEngine | null = null;
	private apiClient: SyncApiClient | null = null;
	private statusBar: StatusBarManager | null = null;
	secretStorage: SecretStorageService;

	async onload(): Promise<void> {
		logger.info('Plugin loaded');
		this.secretStorage = new SecretStorageService(this.app);
		await this.loadSettings();

		// Generate device ID if not set
		if (!this.settings.deviceId) {
			this.settings.deviceId = this.generateDeviceId();
			await this.saveSettings();
		}

		// Add settings tab
		this.addSettingTab(new CrateSettingTab(this.app, this));

		// Initialize sync if configured
		if (this.isConfigured()) {
			await this.initializeSync();
		}

		// Add commands
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => this.sync(),
		});

		this.addCommand({
			id: 'test-connection',
			name: 'Test connection',
			callback: async () => {
				const result = await this.testConnection();
				if (result.success) {
					new Notice('Connection successful!');
				} else {
					new Notice(`Connection failed: ${result.error}`);
				}
			},
		});
	}

	onunload(): void {
		this.syncEngine?.destroy();
		this.statusBar?.destroy();
	}

	/**
	 * Load settings from storage
	 */
	async loadSettings(): Promise<void> {
		const data = await this.loadData() as Partial<CrateSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	/**
	 * Save settings to storage
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Check if plugin is configured
	 */
	isConfigured(): boolean {
		return this.settings.workerUrl.length > 0 && this.secretStorage.has(SECRET_KEYS.AUTH_TOKEN);
	}

	/**
	 * Initialize sync engine and related components
	 */
	async initializeSync(): Promise<void> {
		logger.info('Initializing sync engine');
		// Clean up existing instances
		this.syncEngine?.destroy();
		this.statusBar?.destroy();

		// Create API client
		this.apiClient = new SyncApiClient(this.settings.workerUrl, this.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || '');

		// Create sync engine
		this.syncEngine = new SyncEngine(this, this.apiClient, this.settings);

		// Create status bar
		if (this.settings.showStatusBar) {
			this.statusBar = new StatusBarManager(this, true);
		}

		// Set up state change handler
		this.syncEngine.setStateChangeCallback((state: SyncState) => {
			this.statusBar?.update(state);
		});

		// Initialize engine
		await this.syncEngine.initialize();

		// Register file event handlers
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				this.syncEngine?.onFileChange(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				this.syncEngine?.onFileChange(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				this.syncEngine?.onFileDelete(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				this.syncEngine?.onFileRename(file, oldPath);
			})
		);

		// Sync on startup if enabled
		if (this.settings.syncOnStartup) {
			// Delay initial sync to let Obsidian fully load
			setTimeout(() => this.sync(), 3000);
		}
	}

	/**
	 * Update sync settings
	 */
	updateSyncSettings(): void {
		this.syncEngine?.updateSettings(this.settings);
	}

	/**
	 * Update status bar visibility
	 */
	updateStatusBar(enabled: boolean): void {
		if (enabled && !this.statusBar) {
			this.statusBar = new StatusBarManager(this, true);
			if (this.syncEngine) {
				this.statusBar.update(this.syncEngine.getState());
			}
		} else if (!enabled && this.statusBar) {
			this.statusBar.destroy();
			this.statusBar = null;
		}
	}

	/**
	 * Test connection to worker
	 */
	async testConnection(): Promise<{ success: boolean; error?: string }> {
		if (!this.apiClient) {
			return { success: false, error: 'Not configured' };
		}
		return this.apiClient.testConnection();
	}

	/**
	 * Perform full sync
	 */
	async sync(): Promise<SyncResult> {
		if (!this.syncEngine) {
			return {
				success: false,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: ['Not configured'],
			};
		}

		logger.info('Sync triggered');
		const result = await this.syncEngine.sync();

		// Save updated last sync time
		await this.saveSettings();

		return result;
	}

	/**
	 * Perform initial sync (upload all files)
	 */
	async initialSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
		if (!this.syncEngine) {
			return {
				success: false,
				uploaded: 0,
				downloaded: 0,
				deleted: 0,
				conflicts: [],
				errors: ['Not configured'],
			};
		}

		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
			progressCallback?.(current, total);
		};

		try {
			const result = await this.syncEngine.initialSync(wrappedCallback);

			// Save updated settings
			await this.saveSettings();

			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
	}

	/**
	 * Generate a unique device ID
	 */
	private generateDeviceId(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let id = 'device-';
		for (let i = 0; i < 8; i++) {
			id += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return id;
	}
}
