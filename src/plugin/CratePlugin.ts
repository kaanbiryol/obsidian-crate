/**
 * Crate - Sync your vault to Cloudflare R2 + Reminders
 */

import { Plugin } from 'obsidian';
import { type CloudflareDeploymentService } from '../cloudflare/deployment-service';
import { type ReminderIndex } from '../reminders/data/reminder-index';
import { type MarkdownWriter } from '../reminders/data/markdown-writer';
import { type ReminderRepository } from '../reminders/data/reminder-repository';
import { reinitializeReminders } from '../reminders/plugin-integration';
import {
	type RemindersSettings,
	useRemindersSettingsStore,
} from '../reminders/settings';
import {
	loadRemindersSettings as loadReminderSettingsState,
	writeRemindersSettings as writeReminderSettingsState,
} from '../reminders/settings-storage';
import { type VaultWatcher } from '../reminders/services/vaultWatcher';
import { activateOrRevealRemindersLeaf } from '../reminders/ui/workspaceLayout';
import { SyncRuntime } from '../sync/runtime';
import type { CrateSettingTab } from '../ui/settings-tab';
import { configureSyncLogger } from './logger';
import { bootstrapPlugin, shutdownPlugin } from './lifecycle';
import { createSettingsUiState, type SettingsUiState } from './settings-ui-state';
import { SecretStorageService } from './secret-storage';
import { buildPersistedCrateSettings, normalizeCrateSettings, type CrateSettings } from './settings';

export default class CratePlugin extends Plugin {
	settings!: CrateSettings;
	secretStorage!: SecretStorageService;
	syncRuntime!: SyncRuntime;
	cloudflareDeploymentService!: CloudflareDeploymentService;
	readonly settingsUiState: SettingsUiState = createSettingsUiState();
	private settingTab?: CrateSettingTab;

	// Reminders
	reminderIndex!: ReminderIndex;
	markdownWriter!: MarkdownWriter;
	reminderRepository!: ReminderRepository;
	remindersSettings: RemindersSettings = useRemindersSettingsStore.getState();
	remindersVaultWatcher?: VaultWatcher;

	async onload(): Promise<void> {
		await bootstrapPlugin(this);
	}

	onunload(): void {
		shutdownPlugin(this);
		// Preserve reminders leaves so Obsidian restores the pane in place on reload.
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData() as Partial<CrateSettings> | null;
		this.settings = normalizeCrateSettings(data, this.app.vault.configDir);
		configureSyncLogger({ enabled: this.settings.syncDebugLogging });
	}

	async saveSettings(): Promise<void> {
		const normalizedSettings = normalizeCrateSettings(this.settings, this.app.vault.configDir);
		Object.assign(this.settings, normalizedSettings);
		await this.saveData(buildPersistedCrateSettings(this.settings));
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

	clearSettingsUiState(): void {
		this.settingsUiState.diagnostics = null;
	}

	registerSettingsTab(settingTab: CrateSettingTab): void {
		this.settingTab = settingTab;
		this.addSettingTab(settingTab);
	}

	openSettingsTab(): void {
		type AppWithSettings = CratePlugin['app'] & {
			setting: {
				open: () => void;
				openTabById: (id: string) => void;
			};
		};

		const settings = (this.app as AppWithSettings).setting;
		settings.open();
		settings.openTabById(this.manifest.id);
	}

	refreshSettingsTab(): void {
		this.settingTab?.display();
	}
}
