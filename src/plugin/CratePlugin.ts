/**
 * Crate - Sync your vault to Cloudflare R2 + Reminders
 */

import { Plugin } from 'obsidian';
import { CloudflareSessionManager } from '../cloudflare/session-manager';
import { CloudflareUsageService } from '../cloudflare/usage-service';
import { type ReminderIndex } from '../reminders/data/reminderIndex';
import { type MarkdownWriter } from '../reminders/data/markdownWriter';
import { type StorageCompat } from '../reminders/data/storageCompat';
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
import { configureSyncLogger } from './logger';
import { bootstrapPlugin, shutdownPlugin } from './lifecycle';
import { createSettingsUiState, type SettingsUiState } from './settings-ui-state';
import { SecretStorageService } from './secret-storage';
import { buildPersistedCrateSettings, normalizeCrateSettings, type CrateSettings } from './settings';

export default class CratePlugin extends Plugin {
	settings!: CrateSettings;
	secretStorage!: SecretStorageService;
	cloudflareSession!: CloudflareSessionManager;
	syncRuntime!: SyncRuntime;
	readonly usageService = new CloudflareUsageService();
	readonly settingsUiState: SettingsUiState = createSettingsUiState();

	// Reminders
	reminderIndex!: ReminderIndex;
	markdownWriter!: MarkdownWriter;
	storage!: StorageCompat;
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
		this.settings = normalizeCrateSettings(this.settings, this.app.vault.configDir);
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
		this.settingsUiState.usage = null;
		this.settingsUiState.diagnostics = null;
	}
}
