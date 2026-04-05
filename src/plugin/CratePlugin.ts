/**
 * Crate - Sync your vault to Cloudflare R2 + Reminders
 */

import { Notice, Plugin } from 'obsidian';
import { CloudflareSessionManager } from '../cloudflare/session-manager';
import { CloudflareUsageService } from '../cloudflare/usage-service';
import { type ReminderIndex } from '../reminders/data/reminderIndex';
import { type MarkdownWriter } from '../reminders/data/markdownWriter';
import { type StorageCompat } from '../reminders/data/storageCompat';
import { initializeReminders, reinitializeReminders } from '../reminders/plugin-integration';
import {
	type RemindersSettings,
	useRemindersSettingsStore,
} from '../reminders/settings';
import {
	loadRemindersSettings as loadReminderSettingsState,
	writeRemindersSettings as writeReminderSettingsState,
} from '../reminders/settings-storage';
import { type VaultWatcher } from '../reminders/services/vaultWatcher';
import { openFullScreenReminderModal } from '../reminders/ui/modals';
import { activateOrRevealRemindersLeaf } from '../reminders/ui/workspaceLayout';
import {
	handleSyncSetupProtocol,
	initializeSyncManagers,
	registerSyncCommands,
	registerVaultSyncEventHandlers,
} from '../sync/plugin-integration';
import { SyncRuntime } from '../sync/runtime';
import { CrateSettingTab } from '../ui/settings-tab';
import { configureSyncLogger, createLogger, errorMessage } from './logger';
import { SecretStorageService } from './secret-storage';
import { normalizeCrateSettings, type CrateSettings } from './settings';

const logger = createLogger('Plugin');

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
	remindersVaultWatcher?: VaultWatcher;

	async onload(): Promise<void> {
		logger.info('Plugin loaded');

		try {
			this.secretStorage = new SecretStorageService(this.app);
			await this.loadSettings();
			initializeSyncManagers(this);
			await this.ensureDeviceId();
		} catch (error) {
			const msg = errorMessage(error);
			logger.error('Plugin initialization failed:', msg);
			new Notice(`Crate failed to initialize: ${msg}`);
			return;
		}

		this.addSettingTab(new CrateSettingTab(this.app, this));
		registerVaultSyncEventHandlers(this);

		try {
			if (this.syncRuntime.isConfigured()) {
				await this.syncRuntime.initialize();
			} else {
				this.showSetupNotice();
			}
		} catch (error) {
			const msg = errorMessage(error);
			logger.error('Sync initialization failed:', msg);
			new Notice(`Crate sync failed to start: ${msg}`);
		}

		registerSyncCommands(this);
		this.registerObsidianProtocolHandler('crate-setup', (params) => {
			void handleSyncSetupProtocol(this, params);
		});
		this.registerObsidianProtocolHandler('crate-reminders', (params) => {
			openFullScreenReminderModal(this, params.project || undefined);
		});

		try {
			await initializeReminders(this);
		} catch (error) {
			const msg = errorMessage(error);
			logger.error('Reminders initialization failed:', msg);
			new Notice(`Reminders failed to initialize: ${msg}`);
		}
	}

	onunload(): void {
		this.syncRuntime?.destroy();
		this.remindersVaultWatcher?.unregister();
		// Preserve reminders leaves so Obsidian restores the pane in place on reload.
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData() as Partial<CrateSettings> | null;
		this.settings = normalizeCrateSettings(data, this.app.vault.configDir);
		configureSyncLogger({ enabled: this.settings.syncDebugLogging });
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeCrateSettings(this.settings, this.app.vault.configDir);
		await this.saveData(this.settings);
	}

	async loadRemindersSettings(): Promise<void> {
		await loadReminderSettingsState(this);
	}

	async writeRemindersSettings(update: Partial<RemindersSettings>): Promise<void> {
		await writeReminderSettingsState(this, update);
	}

	async activateRemindersView(): Promise<void> {
		await activateOrRevealRemindersLeaf(this.app.workspace, 'reminders-view');
	}

	async reinitializeWithFolder(newFolderPath: string): Promise<void> {
		await reinitializeReminders(this, newFolderPath);
	}

	private showSetupNotice(): void {
		const fragment = new DocumentFragment();
		fragment.createSpan({ text: 'Crate is not configured. ' });
		const link = fragment.createEl('a', { text: 'Open settings' });
		link.addEventListener('click', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app as any).setting.open();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app as any).setting.openTabById(this.manifest.id);
		});
		fragment.createSpan({ text: ' to set up sync.' });
		new Notice(fragment, 10000);
	}

	private async ensureDeviceId(): Promise<void> {
		if (this.settings.deviceId) return;
		this.settings.deviceId = this.generateDeviceId();
		await this.saveSettings();
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
