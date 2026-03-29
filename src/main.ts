/**
 * Crate - Sync your vault to Cloudflare R2 + Reminders
 */

import './styles/main.scss';

import { MarkdownPostProcessorContext, Notice, Plugin, TAbstractFile } from 'obsidian';
import { abortOAuthLogin } from './cloudflare/oauth';
import { CloudflareSessionManager } from './cloudflare/session-manager';
import { CloudflareUsageService } from './cloudflare/usage-service';
import { createLogger } from './logger';
import { SecretStorageService } from './secret-storage';
import { DEFAULT_SETTINGS, type CrateSettings } from './settings';
import { SECRET_KEYS } from './types';
import { notifyConflicts } from './sync/conflict';
import { isHiddenPath } from './sync/file-discovery';
import { SyncRuntime } from './sync/runtime';
import { normalizeWorkerUrl } from './sync/worker-url';
import { ActivityModal } from './ui/activity-modal';
import { openConfirmationModal } from './ui/confirmation-modal';
import { CrateSettingTab } from './ui/settings-tab';

// Reminders imports
import { configureLogger } from './reminders/utils/logger';
import { createReminderIndex, type ReminderIndex } from './reminders/data/reminderIndex';
import { createMarkdownWriter, type MarkdownWriter } from './reminders/data/markdownWriter';
import { createStorageCompat, type StorageCompat } from './reminders/data/storageCompat';
import { VaultWatcher } from './reminders/services/vaultWatcher';
import { FileRenameHandler } from './reminders/services/fileRenameHandler';
import { ReminderQueryInjector } from './reminders/query/injector';
import { createRemindersBlockExtension } from './reminders/query/remindersBlockLivePreview';
import { createInlineTodoExtension } from './reminders/query/inlineTodoLivePreview';
import { registerReminderCommands } from './reminders/commands';
import {
	type RemindersSettings,
	normalizeRemindersFolderPath,
	useRemindersSettingsStore,
} from './reminders/settings';
import { RemindersView, VIEW_TYPE_REMINDERS } from './reminders/ui/reminders-view';
import { activateOrRevealRemindersLeaf } from './reminders/ui/workspaceLayout';
import { openFullScreenReminderModal } from './reminders/ui/modals';
import { ReminderNotificationService } from './reminders/services/notificationService';

const logger = createLogger('Plugin');
const remindersLogger = createLogger('Reminders');

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
	const parsed: unknown = JSON.parse(raw);
	return isRecord(parsed) ? parsed : null;
}

function parseStringArray(raw: string): string[] | null {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		return null;
	}

	const values: string[] = [];
	for (const item of parsed) {
		if (typeof item !== 'string') {
			return null;
		}
		values.push(item);
	}
	return values;
}

function ensureStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}

	return value.filter((item): item is string => typeof item === 'string');
}

function ensureConfigDirWorkspaceIgnorePattern(ignorePatterns: string[], configDir: string): string[] {
	const normalizedConfigDir = configDir.replace(/^\/+|\/+$/g, '');
	if (!normalizedConfigDir) {
		return ignorePatterns;
	}

	const workspacePattern = `${normalizedConfigDir}/workspace*`;
	if (ignorePatterns.includes(workspacePattern)) {
		return ignorePatterns;
	}

	return [...ignorePatterns, workspacePattern];
}

export default class CratePlugin extends Plugin {
	settings!: CrateSettings;
	secretStorage!: SecretStorageService;
	cloudflareSession!: CloudflareSessionManager;
	syncRuntime!: SyncRuntime;
	readonly usageService = new CloudflareUsageService();

	// Reminders
	reminderIndex!: ReminderIndex;
	markdownWriter!: MarkdownWriter;
	storage!: StorageCompat;
	remindersSettings: RemindersSettings = useRemindersSettingsStore.getState();
	private remindersVaultWatcher?: VaultWatcher;
	private cachedStyles: string | null = null;

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
				void this.handleSetupProtocol(params);
			});
			this.registerObsidianProtocolHandler('crate-reminders', (params) => {
				openFullScreenReminderModal(this, params.project || undefined);
		});

		// Initialize reminders after sync is ready
		try {
			await this.initializeReminders();
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			remindersLogger.error('Reminders initialization failed:', msg);
			new Notice(`Reminders failed to initialize: ${msg}`);
		}
	}

	onunload(): void {
		this.syncRuntime.destroy();
		abortOAuthLogin();
		this.remindersVaultWatcher?.unregister();
		// Preserve reminders leaves so Obsidian restores the pane in place on reload.
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData() as Partial<CrateSettings> | null;
		const merged = Object.assign({}, DEFAULT_SETTINGS, data);
		merged.workerUrl = normalizeWorkerUrl(typeof merged.workerUrl === 'string' ? merged.workerUrl : '');
		merged.deviceId = typeof merged.deviceId === 'string' ? merged.deviceId.trim() : '';
		merged.ignorePatterns = ensureConfigDirWorkspaceIgnorePattern(
			ensureStringArray(merged.ignorePatterns, DEFAULT_SETTINGS.ignorePatterns),
			this.app.vault.configDir,
		);
		this.settings = merged;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// --- Reminders settings (stored in separate file) ---

	async loadRemindersSettings(): Promise<void> {
		const settingsData = await this.loadRemindersSettingsData();

		if (settingsData) {
			const loaded = settingsData as Record<string, unknown>;
			// Migrate old setting name
			if ('autoOpenSidebarOnMobile' in loaded) {
				if (loaded.autoOpenSidebarOnMobile === true) {
					loaded.autoOpenView = 'sidebar';
				}
				delete loaded.autoOpenSidebarOnMobile;
			}
			// Drop CalDAV syncMethod
			delete loaded.syncMethod;
			const normalizedSettingsData: Partial<RemindersSettings> = {
				...settingsData,
				remindersFolderPath: normalizeRemindersFolderPath(
					typeof loaded.remindersFolderPath === 'string' ? loaded.remindersFolderPath : undefined,
				),
			};

			useRemindersSettingsStore.setState((old) => ({
				...old,
				...normalizedSettingsData,
			}), true);
		}

		this.remindersSettings = useRemindersSettingsStore.getState();
		await this.saveRemindersSettingsData(this.remindersSettings);
	}

	async writeRemindersSettings(update: Partial<RemindersSettings>): Promise<void> {
		const normalizedUpdate = { ...update };
		if (Object.prototype.hasOwnProperty.call(normalizedUpdate, 'remindersFolderPath')) {
			normalizedUpdate.remindersFolderPath = normalizeRemindersFolderPath(normalizedUpdate.remindersFolderPath);
		}
		useRemindersSettingsStore.setState(normalizedUpdate);
		this.remindersSettings = useRemindersSettingsStore.getState();
		await this.saveRemindersSettingsData(this.remindersSettings);
	}

	private async loadRemindersSettingsData(): Promise<Partial<RemindersSettings> | null> {
		try {
				const adapter = this.app.vault.adapter;
				const settingsPath = this.getPluginDataPath('reminders-settings.json');
				if (await adapter.exists(settingsPath)) {
					const content = await adapter.read(settingsPath);
					return parseJsonRecord(content);
				}
			} catch (error) {
				remindersLogger.error('Failed to load reminders settings:', error);
		}
		return null;
	}

	private async saveRemindersSettingsData(settings: RemindersSettings): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			await this.ensurePluginDataDir();
			const settingsPath = this.getPluginDataPath('reminders-settings.json');
			await adapter.write(settingsPath, JSON.stringify(settings, null, 2));
		} catch (error) {
			remindersLogger.error('Failed to save reminders settings:', error);
		}
	}

	private async ensurePluginDataDir(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		if (await adapter.exists(pluginDir)) {
			return;
		}

		try {
			await adapter.mkdir(pluginDir);
		} catch {
			// Best effort: the directory may have been created concurrently.
		}
	}

	private getPluginDataPath(filename: string): string {
		const configDir = this.app.vault.configDir;
		const pluginId = this.manifest.id;
		return `${configDir}/plugins/${pluginId}/${filename}`;
	}

	// --- Reminders initialization ---

	private async initializeReminders(): Promise<void> {
		await this.loadRemindersSettings();

		configureLogger({ prefix: 'Crate', enabled: this.remindersSettings.debugLogging });

		remindersLogger.info(`Initializing reminders for folder: ${this.remindersSettings.remindersFolderPath}`);
		this.reminderIndex = createReminderIndex(this.app, this.remindersSettings.remindersFolderPath);
		await this.reminderIndex.load();
		remindersLogger.info(`Index loaded: ${this.reminderIndex.getAll().length} reminders`);

		this.markdownWriter = createMarkdownWriter(this.app, this.reminderIndex);
		this.storage = createStorageCompat(this.reminderIndex, this.markdownWriter);
		this.configureReminderWriterCallbacks();

		this.remindersVaultWatcher = new VaultWatcher(this, this.reminderIndex);
		this.remindersVaultWatcher.register();

		const fileRenameHandler = new FileRenameHandler(this);
		fileRenameHandler.register();

		// Code block processors
		const queryProcessor = new ReminderQueryInjector(this);
		this.registerMarkdownCodeBlockProcessor(
			'reminders',
			(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onNewBlock(source, el, ctx),
		);
		this.registerMarkdownCodeBlockProcessor(
			'reminders-tasks',
			(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onNewBlock(source, el, ctx),
		);
		this.registerMarkdownCodeBlockProcessor(
			'reminders-today',
			(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onTodayBlock(source, el, ctx),
		);
		this.registerMarkdownCodeBlockProcessor(
			'reminders-upcoming',
			(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => queryProcessor.onUpcomingBlock(source, el, ctx),
		);

		// Editor extensions
		try {
			this.registerEditorExtension(createRemindersBlockExtension(this));
		} catch (error) {
			remindersLogger.error('Failed to register reminder block extension:', error);
		}
		try {
			this.registerEditorExtension(createInlineTodoExtension(this));
		} catch (error) {
			remindersLogger.error('Failed to register inline todo extension:', error);
		}

		// Sidebar view
			this.registerView(
				VIEW_TYPE_REMINDERS,
				(leaf) => new RemindersView(leaf, this),
			);
			this.addRibbonIcon('check-circle', 'Open reminders', () => {
				void this.activateRemindersView();
			});

		// Reminders commands
		registerReminderCommands(this);

			this.addCommand({
				id: 'open-reminders-view',
				name: 'Open reminders sidebar',
				callback: () => this.activateRemindersView(),
			});
			this.addCommand({
				id: 'open-reminders-fullscreen',
				name: 'Open reminders full screen',
				callback: () => openFullScreenReminderModal(this),
			});

		// Auto-open view
			if (this.remindersSettings.autoOpenView !== 'none') {
				this.app.workspace.onLayoutReady(() => {
					if (this.remindersSettings.autoOpenView === 'sidebar') {
						void this.activateRemindersView();
					} else if (this.remindersSettings.autoOpenView === 'fullscreen') {
						openFullScreenReminderModal(this);
					}
			});
		}
	}

	async activateRemindersView(): Promise<void> {
		await activateOrRevealRemindersLeaf(this.app.workspace, VIEW_TYPE_REMINDERS);
	}

	async reinitializeWithFolder(newFolderPath: string): Promise<void> {
		const normalizedFolderPath = normalizeRemindersFolderPath(newFolderPath);
		remindersLogger.info(`Reinitializing with new folder: ${normalizedFolderPath}`);
		this.remindersVaultWatcher?.unregister();

		this.reminderIndex = createReminderIndex(this.app, normalizedFolderPath);
		await this.reminderIndex.load();
		this.markdownWriter = createMarkdownWriter(this.app, this.reminderIndex);
		this.storage = createStorageCompat(this.reminderIndex, this.markdownWriter);
		this.configureReminderWriterCallbacks();

		this.remindersVaultWatcher = new VaultWatcher(this, this.reminderIndex);
		this.remindersVaultWatcher.register();
		remindersLogger.info('Reinitialization complete');
	}

	async loadStyles(): Promise<string> {
		if (this.cachedStyles) return this.cachedStyles;
		try {
			const stylesPath = `${this.manifest.dir}/styles.css`;
			this.cachedStyles = await this.app.vault.adapter.read(stylesPath);
			return this.cachedStyles;
		} catch (error) {
			remindersLogger.error('Failed to load styles.css:', error);
			return '';
		}
	}

	// --- Sync ---

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
		this.syncRuntime.setStatusBarClickHandler(() => {
			new ActivityModal(this.app, this.settings, this.syncRuntime).open();
		});
	}

	private async ensureDeviceId(): Promise<void> {
		if (this.settings.deviceId) return;
		this.settings.deviceId = this.generateDeviceId();
		await this.saveSettings();
	}

	private configureReminderWriterCallbacks(): void {
		this.markdownWriter.setOnFileWritten(async (file) => {
			await this.reminderIndex.rescanFile(file, true);
		});

		const notificationService = new ReminderNotificationService(
			() => this.settings,
			() => this.syncRuntime.getApiClient(),
		);
		this.markdownWriter.setOnReminderChange(async (reminder, operation) => {
			const result = await notificationService.onReminderChange(reminder, operation);
			if (!result.success) {
				new Notice(`Reminder saved but notification sync failed:\n${result.error}`, 5000);
			}
			return result;
		});
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
			id: 'show-activity',
			name: 'Show sync activity',
			callback: () => {
				new ActivityModal(this.app, this.settings, this.syncRuntime).open();
			},
		});

		this.addCommand({
			id: 'force-full-sync',
			name: 'Force full sync (overwrite remote)',
			callback: async () => {
				const confirmed = await openConfirmationModal(this.app, {
					title: 'Force full sync',
					message: 'Overwrite the remote vault with local files?',
					details: [
						'Remote-only files will be deleted.',
						'This action cannot be undone.',
					],
					confirmText: 'Force full sync',
					warning: true,
				});
				if (!confirmed) {
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

	private registerVaultEventHandlers(): void {
		if (this.vaultEventsRegistered) return;
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

		type RawOn = (name: 'raw', callback: (path: string) => void) => import('obsidian').EventRef;
		this.registerEvent(
			(this.app.vault.on as unknown as RawOn)(
				'raw',
				(path: string) => {
					if (isHiddenPath(path)) {
						this.syncRuntime.onRawFileEvent(path);
					}
				},
			)
		);
	}

	private async handleSetupProtocol(params: Record<string, string>): Promise<void> {
		const workerUrl = params['workerUrl'];
		const authToken = params['authToken'];

		if (!workerUrl || !authToken) {
			new Notice('Setup link is missing required parameters.');
			return;
		}

		if (this.syncRuntime.isConfigured()) {
			const confirmed = await openConfirmationModal(this.app, {
				title: 'Overwrite existing configuration',
				message: 'Crate is already configured on this device.',
				details: ['Applying the setup link will replace the current sync credentials.'],
				confirmText: 'Overwrite configuration',
				warning: true,
			});
			if (!confirmed) {
				return;
			}
		}

		try {
			if (params['ignorePatterns']) {
				try {
					const parsedIgnorePatterns = parseStringArray(params['ignorePatterns']);
					if (parsedIgnorePatterns) {
						this.settings.ignorePatterns = parsedIgnorePatterns;
					}
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

			if (params['analyticsToken']) {
				this.secretStorage.set(SECRET_KEYS.ANALYTICS_TOKEN, params['analyticsToken']);
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
		const bytes = new Uint8Array(8);
		crypto.getRandomValues(bytes);
		let id = 'device-';
		for (const value of bytes) {
			id += chars.charAt(value % chars.length);
		}
		return id;
	}
}
