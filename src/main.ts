/**
 * Obsidian Crate - Sync your vault to Cloudflare R2
 */

import { Notice, Plugin, TAbstractFile } from 'obsidian';
import { abortOAuthLogin } from './cloudflare/oauth';
import { CloudflareSessionManager } from './cloudflare/session-manager';
import { CloudflareUsageService } from './cloudflare/usage-service';
import { createLogger } from './logger';
import { SecretStorageService } from './secret-storage';
import { DEFAULT_SETTINGS, type CrateSettings } from './settings';
import { notifyConflicts } from './sync/conflict';
import { SyncRuntime } from './sync/runtime';
import { CrateSettingTab } from './ui/settings-tab';

const logger = createLogger('Plugin');

export default class CratePlugin extends Plugin {
	settings!: CrateSettings;
	secretStorage!: SecretStorageService;
	cloudflareSession!: CloudflareSessionManager;
	syncRuntime!: SyncRuntime;
	readonly usageService = new CloudflareUsageService();

	private vaultEventsRegistered = false;

	async onload(): Promise<void> {
		logger.info('Plugin loaded');

		try {
			this.secretStorage = new SecretStorageService(this.app);
			await this.loadSettings();
			this.initializeManagers();
			await this.ensureDeviceId();
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			logger.error('Plugin initialization failed:', msg);
			new Notice(`Crate failed to initialize: ${msg}`);
			return;
		}

		this.addSettingTab(new CrateSettingTab(this.app, this));
		this.registerVaultEventHandlers();

		try {
			if (this.syncRuntime.isConfigured()) {
				await this.syncRuntime.initialize();
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			logger.error('Sync initialization failed:', msg);
			new Notice(`Crate sync failed to start: ${msg}`);
		}

		this.registerCommands();
		this.registerObsidianProtocolHandler('crate-setup', (params) => {
			this.handleSetupProtocol(params);
		});
	}

	onunload(): void {
		this.syncRuntime.destroy();
		abortOAuthLogin();
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData() as Partial<CrateSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private initializeManagers(): void {
		this.cloudflareSession = new CloudflareSessionManager(
			this.settings,
			this.secretStorage,
			() => this.saveSettings()
		);
		this.syncRuntime = new SyncRuntime(
			this,
			this.settings,
			this.secretStorage,
			() => this.saveSettings()
		);
	}

	private async ensureDeviceId(): Promise<void> {
		if (this.settings.deviceId) {
			return;
		}

		this.settings.deviceId = this.generateDeviceId();
		await this.saveSettings();
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: async () => {
				const result = await this.syncRuntime.sync();
				notifyConflicts(result.conflicts);
			},
		});

		this.addCommand({
			id: 'test-connection',
			name: 'Test connection',
			callback: async () => {
				const result = await this.syncRuntime.testConnection();
				if (result.success) {
					new Notice('Connection successful!');
				} else {
					new Notice(`Connection failed: ${result.error}`);
				}
			},
		});

		this.addCommand({
			id: 'force-full-sync',
			name: 'Force full sync (overwrite remote)',
			callback: async () => {
				if (!confirm('This will overwrite ALL remote files with your local vault and delete remote-only files. Continue?')) {
					return;
				}

				new Notice('Force full sync started...');
				const result = await this.syncRuntime.forceFullSync();
				if (result.success) {
					new Notice(`Force sync complete: ${result.uploaded} uploaded, ${result.deleted} deleted`);
				} else {
					new Notice(`Force sync completed with errors: ${result.errors.join(', ')}`);
				}
			},
		});
	}

	/**
	 * Register vault change handlers once for plugin lifetime.
	 */
	private registerVaultEventHandlers(): void {
		if (this.vaultEventsRegistered) {
			return;
		}
		this.vaultEventsRegistered = true;

		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				this.syncRuntime.onFileChange(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('modify', (file: TAbstractFile) => {
				this.syncRuntime.onFileChange(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				this.syncRuntime.onFileDelete(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				this.syncRuntime.onFileRename(file, oldPath);
			})
		);
	}

	private async handleSetupProtocol(params: Record<string, string>): Promise<void> {
		const workerUrl = params['workerUrl'];
		const authToken = params['authToken'];

		if (!workerUrl || !authToken) {
			new Notice('Setup link is missing required parameters (workerUrl, authToken)');
			return;
		}

		if (this.syncRuntime.isConfigured()) {
			if (!confirm('Crate is already configured. Overwrite with new credentials from setup link?')) {
				return;
			}
		}

		try {
			if (params['ignorePatterns']) {
				try {
					this.settings.ignorePatterns = JSON.parse(params['ignorePatterns']);
				} catch { /* keep existing */ }
			}
			if (params['syncOnStartup'] !== undefined) {
				this.settings.syncOnStartup = params['syncOnStartup'] === 'true';
			}
			if (params['syncInterval'] !== undefined) {
				const interval = parseInt(params['syncInterval'], 10);
				if (!isNaN(interval)) {
					this.settings.syncInterval = interval;
				}
			}
			if (params['showStatusBar'] !== undefined) {
				this.settings.showStatusBar = params['showStatusBar'] === 'true';
			}

			await this.syncRuntime.applyInfrastructureConfig({
				workerUrl,
				authToken,
				workerName: params['workerName'] || '',
				bucketName: params['bucketName'] || '',
				databaseId: params['databaseId'] || '',
				accountId: params['accountId'] || undefined,
			});
			new Notice('Crate configured from setup link');

			const result = await this.syncRuntime.testConnection();
			if (result.success) {
				new Notice('Connection test successful!');
			} else {
				new Notice(`Configured but connection test failed: ${result.error}`);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`Setup link failed: ${msg}`);
		}
	}

	private generateDeviceId(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
		let id = 'device-';
		for (let i = 0; i < 8; i++) {
			id += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return id;
	}
}
