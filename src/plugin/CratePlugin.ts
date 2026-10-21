/**
 * Crate - Sync your vault to Cloudflare R2 + Reminders
 */

import { Plugin } from 'obsidian';
import type { CloudflareUsageConnection } from '../cloudflare/usage/connection';
import { type CloudflareDeploymentService } from '../cloudflare/deployment/service';
import {
	type RemindersSettings,
	normalizeRemindersSettings,
	useRemindersSettingsStore,
} from '../reminders/settings';
import { type ReminderBackend } from '../reminders/runtime';
import { configureLogger as configureRemindersLogger } from '../reminders/logger';
import { SyncRuntime } from '../sync/runtime/runtime';
import type { CrateSettingTab } from '../ui/settings-tab';
import { configureSyncLogger } from '../sync/logger';
import { bootstrapPlugin, shutdownPlugin } from './lifecycle';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { publishSavedSettings } from './settings-persistence';
import { createSettingsUiState, type SettingsUiState } from '../ui/settings/settings-ui-state';
import { SecretStorageService } from './secret-storage';
import {
	buildPersistedCrateSettings,
	normalizeCrateSettings,
	normalizePersistedCrateSettings,
	type CrateSettings,
	type PersistedCrateSettings,
} from './settings';

type PluginData = Partial<PersistedCrateSettings> & {
	reminders?: Partial<RemindersSettings>;
};

export default class CratePlugin extends Plugin {
	settings!: CrateSettings;
	secretStorage!: SecretStorageService;
	syncRuntime!: SyncRuntime;
	cloudflareDeploymentService!: CloudflareDeploymentService;
	cloudflareUsageConnection!: CloudflareUsageConnection;
	readonly settingsUiState: SettingsUiState = createSettingsUiState();
	private settingTab?: CrateSettingTab;
	private settingsWriteQueue: Promise<void> = Promise.resolve();

	// Reminders: set while the reminders backend is loaded
	reminders?: ReminderBackend;

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
		const signal = getPluginLifecycleSignal(this);
		const data = await this.loadData() as PluginData | null;
		if (signal.aborted) return;
		this.settings = normalizeCrateSettings(data, this.app.vault.configDir);
		const remindersSettings = normalizeRemindersSettings(data?.reminders);
		useRemindersSettingsStore.setState(remindersSettings, true);
		configureSyncLogger({ enabled: this.settings.debugLogging });
		configureRemindersLogger({ prefix: 'Crate', enabled: this.settings.debugLogging });
	}

	async saveSettings(): Promise<void> {
		await this.enqueueSettingsWrite(async signal => {
			await this.persist(normalizePersistedCrateSettings(this.settings, this.app.vault.configDir));
			signal.throwIfAborted();
		});
	}

	async writeSettings(update: Partial<PersistedCrateSettings>, assertCurrent?: () => void): Promise<void> {
		const requested = { ...update };
		await this.enqueueSettingsWrite(async signal => {
			assertCurrent?.();
			const nextSettings = normalizePersistedCrateSettings(
				{ ...this.settings, ...requested },
				this.app.vault.configDir,
			);
			await this.persist(nextSettings);
			signal.throwIfAborted();
			assertCurrent?.();
			publishSavedSettings(this.settings, requested, nextSettings);
		});
	}

	async writeRemindersSettings(update: Partial<RemindersSettings> | ((current: RemindersSettings) => Partial<RemindersSettings>), assertCurrent?: () => void): Promise<void> {
		await this.enqueueSettingsWrite(async signal => {
			assertCurrent?.();
			const nextSettings = normalizeRemindersSettings({
				...this.remindersSettings,
				...(typeof update === 'function' ? update(this.remindersSettings) : update),
			});
			await this.persist(buildPersistedCrateSettings(this.settings), nextSettings);
			signal.throwIfAborted();
			assertCurrent?.();
			useRemindersSettingsStore.setState(nextSettings, true);
		});
	}

	async setDebugLogging(enabled: boolean): Promise<void> {
		await this.writeSettings({ debugLogging: enabled });
		configureSyncLogger({ enabled });
		configureRemindersLogger({ prefix: 'Crate', enabled });
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

	getSettingsDocument(): Document | undefined {
		return this.settingTab?.containerEl.ownerDocument;
	}

	refreshSettingsTab(): void {
		this.settingTab?.update();
	}

	/** Core and reminder settings share one plugin data record. */
	private persist(settings: PersistedCrateSettings, reminders = this.remindersSettings): Promise<void> {
		return this.saveData({ ...settings, reminders });
	}

	private enqueueSettingsWrite(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const signal = getPluginLifecycleSignal(this);
		signal.throwIfAborted();
		const run = () => {
			// A queued write can outlive the instance that requested it. Once
			// saveData is dispatched the host cannot cancel it; callers must also
			// check this signal before publishing its result to live settings.
			signal.throwIfAborted();
			return operation(signal);
		};
		const pendingWrite = this.settingsWriteQueue.then(run, run);
		this.settingsWriteQueue = pendingWrite.catch(() => undefined);
		return pendingWrite;
	}
}
