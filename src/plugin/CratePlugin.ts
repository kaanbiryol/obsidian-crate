/**
 * Crate - Sync your vault to Cloudflare R2 + Reminders
 */

import { Plugin } from 'obsidian';
import { type CloudflareDeploymentService } from '../cloudflare/deployment-service';
import { type ReminderIndex } from '../reminders/data/reminder-index';
import { type MarkdownWriter } from '../reminders/data/markdown-writer';
import { type ReminderRepository } from '../reminders/data/reminder-repository';
import { initializeReminders, reinitializeReminders } from '../reminders/plugin-integration';
import {
	type RemindersSettings,
	normalizeRemindersSettings,
	useRemindersSettingsStore,
} from '../reminders/settings';
import { type VaultWatcher } from '../reminders/services/vaultWatcher';
import { activateOrRevealRemindersLeaf } from '../reminders/ui/workspaceLayout';
import { configureLogger as configureRemindersLogger } from '../reminders/utils/logger';
import { SyncRuntime } from '../sync/runtime';
import type { CrateSettingTab } from '../ui/settings-tab';
import { configureSyncLogger } from './logger';
import { bootstrapPlugin, shutdownPlugin } from './lifecycle';
import { createSettingsUiState, type SettingsUiState } from './settings-ui-state';
import { SecretStorageService } from './secret-storage';
import { buildPersistedCrateSettings, normalizeCrateSettings, type CrateSettings } from './settings';

type PluginData = Partial<CrateSettings> & {
	reminders?: Partial<RemindersSettings>;
};

export default class CratePlugin extends Plugin {
	settings!: CrateSettings;
	secretStorage!: SecretStorageService;
	syncRuntime!: SyncRuntime;
	cloudflareDeploymentService!: CloudflareDeploymentService;
	readonly settingsUiState: SettingsUiState = createSettingsUiState();
	private settingTab?: CrateSettingTab;
	private settingsWriteQueue: Promise<void> = Promise.resolve();

	// Reminders
	reminderIndex!: ReminderIndex;
	markdownWriter!: MarkdownWriter;
	reminderRepository!: ReminderRepository;
	remindersVaultWatcher?: VaultWatcher;

	get remindersSettings(): RemindersSettings {
		return useRemindersSettingsStore.getState();
	}

	async onload(): Promise<void> {
		await bootstrapPlugin(this);
	}

	onunload(): void {
		shutdownPlugin(this);
		// Preserve reminders leaves so Obsidian restores the pane in place on reload.
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData() as PluginData | null;
		this.settings = normalizeCrateSettings(data, this.app.vault.configDir);
		const remindersSettings = normalizeRemindersSettings(data?.reminders);
		useRemindersSettingsStore.setState(remindersSettings, true);
		configureSyncLogger({ enabled: this.settings.syncDebugLogging });
		configureRemindersLogger({ prefix: 'Crate', enabled: remindersSettings.debugLogging });
	}

	async saveSettings(): Promise<void> {
		await this.enqueueSettingsWrite(async () => {
			const normalizedSettings = normalizeCrateSettings(this.settings, this.app.vault.configDir);
			await this.saveData({
				...buildPersistedCrateSettings(normalizedSettings),
				reminders: this.remindersSettings,
			});
			Object.assign(this.settings, normalizedSettings);
		});
	}

	async writeSettings(update: Partial<CrateSettings>): Promise<void> {
		await this.enqueueSettingsWrite(async () => {
			const nextSettings = normalizeCrateSettings(
				{ ...this.settings, ...update },
				this.app.vault.configDir,
			);
			await this.saveData({
				...buildPersistedCrateSettings(nextSettings),
				reminders: this.remindersSettings,
			});
			Object.assign(this.settings, nextSettings);
		});
	}

	async writeRemindersSettings(update: Partial<RemindersSettings>): Promise<void> {
		await this.enqueueSettingsWrite(async () => {
			const nextSettings = normalizeRemindersSettings({
				...this.remindersSettings,
				...update,
			});
			await this.saveData({
				...buildPersistedCrateSettings(this.settings),
				reminders: nextSettings,
			});
			useRemindersSettingsStore.setState(nextSettings, true);
			configureRemindersLogger({ prefix: 'Crate', enabled: nextSettings.debugLogging });
		});
	}

	async enableReminders(): Promise<void> {
		if (this.remindersSettings.enabled && this.reminderIndex) {
			return;
		}

		await this.writeRemindersSettings({ enabled: true });
		try {
			await initializeReminders(this);
		} catch (error) {
			this.remindersVaultWatcher?.unregister();
			await this.writeRemindersSettings({ enabled: false });
			throw error;
		}
	}

	async activateRemindersView(project?: string): Promise<void> {
		await activateOrRevealRemindersLeaf(this.app.workspace, 'reminders-view', project);
	}

	async reinitializeWithFolder(newFolderPath: string): Promise<void> {
		if (!this.remindersSettings.enabled) {
			return;
		}
		await reinitializeReminders(this, newFolderPath);
	}

	clearSettingsUiState(): void {
		this.settingsUiState.diagnostics = null;
		this.settingsUiState.devices = null;
	}

	registerSettingsTab(settingTab: CrateSettingTab): void {
		this.settingTab = settingTab;
		this.addSettingTab(settingTab);
	}

	openSettingsTab(): boolean {
		type AppWithSettings = CratePlugin['app'] & {
			setting?: {
				open?: () => void;
				openTabById?: (id: string) => void;
			};
		};

		const settings = (this.app as AppWithSettings).setting;
		if (
			!settings
			|| typeof settings.open !== 'function'
			|| typeof settings.openTabById !== 'function'
		) {
			return false;
		}
		settings.open();
		settings.openTabById(this.manifest.id);
		return true;
	}

	refreshSettingsTab(): void {
		this.settingTab?.update();
	}

	private enqueueSettingsWrite(operation: () => Promise<void>): Promise<void> {
		const pendingWrite = this.settingsWriteQueue.then(operation, operation);
		this.settingsWriteQueue = pendingWrite.catch(() => undefined);
		return pendingWrite;
	}
}
