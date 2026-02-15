/**
 * Obsidian Crate - Sync your vault to Cloudflare R2
 */

import { Plugin, Notice, TAbstractFile, requestUrl } from 'obsidian';
import { CrateSettings, DEFAULT_SETTINGS, SECRET_KEYS } from './settings';
import { SyncEngine } from './sync/engine';
import { SyncApiClient } from './sync/api';
import { SecretStorageService } from './secret-storage';
import { StatusBarManager } from './ui/status';
import { CrateSettingTab } from './ui/settings-tab';
import { createLogger } from './logger';
import { performOAuthLogin, refreshAccessToken } from './cloudflare/oauth';
import type { SyncResult, SyncState, UsageResponse, WorkerConfig } from './types';

const logger = createLogger('Plugin');

export default class CratePlugin extends Plugin {
	settings: CrateSettings;
	private syncEngine: SyncEngine | null = null;
	private apiClient: SyncApiClient | null = null;
	private statusBar: StatusBarManager | null = null;
	private vaultEventsRegistered = false;
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
		this.registerVaultEventHandlers();

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

		this.addCommand({
			id: 'force-full-sync',
			name: 'Force full sync (overwrite remote)',
			callback: async () => {
				if (!confirm('This will overwrite ALL remote files with your local vault and delete remote-only files. Continue?')) {
					return;
				}

				new Notice('Force full sync started...');
				const result = await this.forceFullSync();
				if (result.success) {
					new Notice(`Force sync complete: ${result.uploaded} uploaded, ${result.deleted} deleted`);
				} else {
					new Notice(`Force sync completed with errors: ${result.errors.join(', ')}`);
				}
			},
		});
	}

	onunload(): void {
		this.syncEngine?.destroy();
		this.statusBar?.destroy();
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

	hasCloudflareCredentials(): boolean {
		return this.settings.cloudflareAccountId.length > 0 && this.secretStorage.has(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
	}

	getCloudflareCredentials(): { accountId: string; apiToken: string } | null {
		const accountId = this.settings.cloudflareAccountId.trim();
		const apiToken = (this.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
		if (!accountId || !apiToken) {
			return null;
		}
		return { accountId, apiToken };
	}

	async resolveCloudflareCredentials(): Promise<{ accountId: string; apiToken: string } | null> {
		const accountId = this.settings.cloudflareAccountId.trim();
		let apiToken = (this.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
		const refreshToken = (this.secretStorage.get(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN) || '').trim();

		if (!accountId || !apiToken) {
			return null;
		}

		const expiresAt = this.settings.cloudflareTokenExpiresAt;
		const shouldRefresh = !!refreshToken && !!expiresAt && Date.now() > expiresAt - 60_000;
		if (shouldRefresh) {
			const refreshed = await refreshAccessToken(refreshToken);
			apiToken = refreshed.accessToken;
			await this.saveCloudflareCredentials(accountId, apiToken, {
				refreshToken: refreshed.refreshToken || refreshToken,
				expiresAt: refreshed.expiresAt ?? null,
			});
		}

		return { accountId, apiToken };
	}

	async loginWithCloudflare(): Promise<{ accountId: string }> {
		const result = await performOAuthLogin(async (url: string) => {
			window.open(url, '_blank', 'noopener,noreferrer');
		});

		await this.saveCloudflareCredentials(result.accountId, result.tokens.accessToken, {
			refreshToken: result.tokens.refreshToken,
			expiresAt: result.tokens.expiresAt ?? null,
		});

		return { accountId: result.accountId };
	}

	async saveCloudflareCredentials(
		accountId: string,
		apiToken: string,
		options?: { refreshToken?: string; expiresAt?: number | null }
	): Promise<void> {
		this.settings.cloudflareAccountId = accountId.trim();
		this.settings.cloudflareTokenExpiresAt = options?.expiresAt ?? null;
		this.secretStorage.set(SECRET_KEYS.CLOUDFLARE_API_TOKEN, apiToken.trim());
		if (options && Object.prototype.hasOwnProperty.call(options, 'refreshToken')) {
			const refreshToken = options.refreshToken?.trim() || '';
			if (refreshToken) {
				this.secretStorage.set(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN, refreshToken);
			} else {
				this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN);
			}
		} else if (!options) {
			this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN);
		}
		await this.saveSettings();
	}

	async clearCloudflareCredentials(): Promise<void> {
		this.settings.cloudflareAccountId = '';
		this.settings.cloudflareTokenExpiresAt = null;
		this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
		this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN);
		await this.saveSettings();
	}

	async applyInfrastructureConfig(config: {
		workerUrl: string;
		authToken: string;
		workerName: string;
		bucketName: string;
		databaseId: string;
		accountId?: string;
	}): Promise<void> {
		this.settings.workerUrl = config.workerUrl.trim();
		this.settings.workerName = config.workerName.trim();
		this.settings.bucketName = config.bucketName.trim();
		this.settings.databaseId = config.databaseId.trim();
		if (config.accountId !== undefined) {
			this.settings.cloudflareAccountId = config.accountId.trim();
		}
		this.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, config.authToken.trim());
		await this.saveSettings();
		await this.initializeSync();
	}

	async clearSyncConfiguration(options?: { clearCloudflareCredentials?: boolean }): Promise<void> {
		this.syncEngine?.destroy();
		this.syncEngine = null;
		this.apiClient = null;
		this.statusBar?.destroy();
		this.statusBar = null;

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

		await this.saveSettings();
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
		this.statusBar?.update(this.syncEngine.getState());

		// Sync on startup if enabled
		if (this.settings.syncOnStartup) {
			this.sync();
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
	 * Get Cloudflare usage metrics by querying the GraphQL Analytics API directly
	 */
	async getUsage(): Promise<UsageResponse> {
		const analyticsToken = this.secretStorage.get(SECRET_KEYS.ANALYTICS_TOKEN);
		if (!analyticsToken || !this.apiClient) {
			return { available: false };
		}

		try {
			const config = await this.apiClient.getConfig();
			if (!config.accountId || !config.workerName || !config.bucketName) {
				return { available: false, error: 'Worker config incomplete' };
			}

			return await this.queryAnalytics(analyticsToken, config);
		} catch (error) {
			return { available: false, error: error instanceof Error ? error.message : 'Failed to fetch usage data' };
		}
	}

	private async queryAnalytics(token: string, config: WorkerConfig): Promise<UsageResponse> {
		const CLASS_A_ACTIONS = [
			'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
			'UploadPart', 'UploadPartCopy', 'ListMultipartUploads', 'ListParts',
			'ListBucket', 'ListBucketMultipartUploads', 'ListBucketVersions',
		];

		const now = new Date();
		const today = now.toISOString().split('T')[0]!;
		const monthStart = today.substring(0, 8) + '01';

		const d1Fragment = config.databaseId ? `
			d1Analytics: d1AnalyticsAdaptiveGroups(
				filter: { databaseId: "${config.databaseId}", date_geq: "${today}", date_leq: "${today}" }
				limit: 1
			) {
				sum { readQueries writeQueries }
			}
			d1Storage: d1StorageAdaptiveGroups(
				filter: { databaseId: "${config.databaseId}", date_geq: "${today}", date_leq: "${today}" }
				limit: 1
			) {
				max { databaseSizeBytes }
			}
		` : '';

		const query = `query {
			viewer {
				accounts(filter: { accountTag: "${config.accountId}" }) {
					workersInvocationsAdaptive(
						filter: { scriptName: "${config.workerName}", date_geq: "${today}", date_leq: "${today}" }
						limit: 1
					) {
						sum { requests }
					}
					r2Storage: r2StorageAdaptiveGroups(
						filter: { bucketName: "${config.bucketName}", date_geq: "${today}", date_leq: "${today}" }
						limit: 1
					) {
						max { payloadSize metadataSize }
					}
					r2Ops: r2OperationsAdaptiveGroups(
						filter: { bucketName: "${config.bucketName}", date_geq: "${monthStart}", date_leq: "${today}" }
						limit: 100
						orderBy: [sum_requests_DESC]
					) {
						dimensions { actionType }
						sum { requests }
					}
					${d1Fragment}
				}
			}
		}`;

		const gqlResponse = await requestUrl({
			url: 'https://api.cloudflare.com/client/v4/graphql',
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ query }),
		});

		const gqlData = gqlResponse.json as {
			errors?: Array<{ message: string }>;
			data?: {
				viewer?: {
					accounts?: Array<{
						workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>;
						r2Storage?: Array<{ max?: { payloadSize?: number; metadataSize?: number } }>;
						r2Ops?: Array<{ dimensions?: { actionType?: string }; sum?: { requests?: number } }>;
						d1Analytics?: Array<{ sum?: { readQueries?: number; writeQueries?: number } }>;
						d1Storage?: Array<{ max?: { databaseSizeBytes?: number } }>;
					}>;
				};
			};
		};

		if (gqlData.errors && gqlData.errors.length > 0) {
			return { available: true, error: gqlData.errors[0]!.message };
		}

		const account = gqlData.data?.viewer?.accounts?.[0];
		if (!account) {
			return { available: true, error: 'No account data returned' };
		}

		const workerRequests = account.workersInvocationsAdaptive?.[0]?.sum?.requests || 0;

		const r2StorageRaw = account.r2Storage?.[0]?.max;
		const r2StorageBytes = (r2StorageRaw?.payloadSize || 0) + (r2StorageRaw?.metadataSize || 0);

		let classAOps = 0;
		let classBOps = 0;
		for (const entry of (account.r2Ops || [])) {
			const action = entry.dimensions?.actionType || '';
			const count = entry.sum?.requests || 0;
			if (CLASS_A_ACTIONS.includes(action)) {
				classAOps += count;
			} else {
				classBOps += count;
			}
		}

		const result: UsageResponse = {
			available: true,
			workers: {
				requests: { current: workerRequests, limit: 100000, unit: 'requests' },
			},
			r2: {
				storageBytes: { current: r2StorageBytes, limit: 10 * 1024 * 1024 * 1024, unit: 'bytes' },
				classAOps: { current: classAOps, limit: 1000000, unit: 'requests' },
				classBOps: { current: classBOps, limit: 10000000, unit: 'requests' },
			},
			queriedAt: now.toISOString(),
		};

		if (config.databaseId) {
			const d1A = account.d1Analytics?.[0]?.sum;
			const d1S = account.d1Storage?.[0]?.max;
			result.d1 = {
				rowsRead: { current: d1A?.readQueries || 0, limit: 5000000, unit: 'rows' },
				rowsWritten: { current: d1A?.writeQueries || 0, limit: 100000, unit: 'rows' },
				storageBytes: { current: d1S?.databaseSizeBytes || 0, limit: 5 * 1024 * 1024 * 1024, unit: 'bytes' },
			};
		}

		return result;
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
		const wrappedCallback = (current: number, total: number) => {
			this.statusBar?.setSyncProgress(current, total);
		};

		try {
			const result = await this.syncEngine.sync(wrappedCallback);

			// Save updated last sync time
			await this.saveSettings();

			return result;
		} finally {
			this.statusBar?.clearSyncProgress();
		}
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
	 * Force full sync (overwrite all remote files with local vault)
	 */
	async forceFullSync(progressCallback?: (current: number, total: number) => void): Promise<SyncResult> {
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
			const result = await this.syncEngine.forceFullSync(wrappedCallback);

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
