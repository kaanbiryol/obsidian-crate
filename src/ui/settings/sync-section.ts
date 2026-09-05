import { Notice, Setting, type ButtonComponent } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';
import type { CrateSettings } from '../../plugin/settings-types';
import type { SyncState } from '../../sync/types';
import { createFileSyncProgress, hideFileSyncProgress, runButtonTask, showFileSyncProgress, updateFileSyncProgress } from './action-helpers';
import { renderSyncInterval } from './sync-interval';
import { renderExclusionsSetting } from './exclusions-setting';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from './input-helpers';
import { createSettingsSectionHeading } from './section-helpers';

export interface SyncSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderSyncSection(context: SyncSectionContext): () => void {
	const { containerEl, plugin, rerender } = context;
	const isSyncing = plugin.syncRuntime.getState().status === 'syncing';
	const persistSettings = async (update: Partial<CrateSettings>): Promise<boolean> => {
		try {
			await plugin.writeSettings(update);
			return true;
		} catch (error) {
			new Notice(`Failed to save sync settings: ${errorMessage(error)}`);
			rerender();
			return false;
		}
	};

	createSettingsSectionHeading(containerEl, 'Sync');

	const lastSync = plugin.settings.lastSync;
	const lastSyncDesc = isSyncing
		? 'Sync in progress...'
		: lastSync ? `Last synced: ${new Date(lastSync).toLocaleString()}` : 'Never synced';

	let syncButton: ButtonComponent;
	const syncSetting = new Setting(containerEl)
		.setName('Sync now')
		.setDesc(lastSyncDesc)
		.addButton(button => {
			syncButton = button;
			if (isSyncing) {
				button.setButtonText('Syncing...');
				button.setDisabled(true);
			} else {
				button.setButtonText('Sync now');
				button.setCta();
			}
			button.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Sync now',
					runningText: 'Syncing...',
					task: async () => {
						showFileSyncProgress(syncProgress);
						return plugin.syncRuntime.sync();
					},
					onSuccess: (result) => {
						if (result.success) {
							new Notice(`Sync complete: ${result.uploaded} uploaded, ${result.downloaded} downloaded`);
						} else {
							new Notice(`Sync completed with errors: ${result.errors.join(', ')}`);
						}

						if (result.conflicts.length > 0) {
							new Notice(`${result.conflicts.length} conflict(s) created`);
						}
					},
					onError: () => {
						new Notice('Sync failed');
					},
				});
			});
		});
	const syncProgress = createFileSyncProgress(syncSetting);

	// Show progress bar and subscribe to updates for any running sync
	const onProgress = (current: number, total: number) => {
		updateFileSyncProgress(syncProgress, current, total);
	};
	const onStateChange = (state: SyncState) => {
		if (state.status === 'syncing') {
			showFileSyncProgress(syncProgress);
		} else {
			hideFileSyncProgress(syncProgress);
		}
		const syncing = state.status === 'syncing';
		syncButton.setDisabled(syncing).setButtonText(syncing ? 'Syncing...' : 'Sync now');
		const timestamp = state.lastSync ?? plugin.settings.lastSync;
		syncSetting.setDesc(syncing ? 'Sync in progress...' : timestamp
			? `Last synced: ${new Date(timestamp).toLocaleString()}` : 'Never synced');
	};
	plugin.syncRuntime.addProgressListener(onProgress);
	plugin.syncRuntime.addStateChangeListener(onStateChange);

	if (isSyncing) {
		showFileSyncProgress(syncProgress);
	}

	const cleanup = () => {
		plugin.syncRuntime.removeProgressListener(onProgress);
		plugin.syncRuntime.removeStateChangeListener(onStateChange);
	};

	new Setting(containerEl)
		.setName('Sync on startup')
		.setDesc('Sync when Obsidian starts. Applies to all devices.')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.syncOnStartup)
			.onChange(async (value) => {
				await persistSettings({ syncOnStartup: value });
			}));

	new Setting(containerEl)
		.setName('Sync when Obsidian resumes')
		.setDesc('Sync when you return to Obsidian or reconnect to the internet. Applies to all devices.')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.syncOnResume)
			.onChange(async (value) => {
				await persistSettings({ syncOnResume: value });
			}));

	renderSyncInterval(containerEl, () => plugin.settings.syncInterval, async syncInterval => {
		if (await persistSettings({ syncInterval })) plugin.syncRuntime.updateSyncSettings();
	});

	renderExclusionsSetting(containerEl, plugin, async ignorePatterns => {
		if (await persistSettings({ ignorePatterns })) plugin.syncRuntime.updateSyncSettings();
	});

	new Setting(containerEl)
		.setName('Show sync status')
		.setDesc('Show sync activity in the status bar. Applies to all devices.')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.showStatusBar)
			.onChange(async (value) => {
				if (await persistSettings({ showStatusBar: value })) {
					plugin.syncRuntime.updateStatusBar(value);
				}
			}));

	new Setting(containerEl)
		.setName('Sync delay after editing (seconds)')
		.setDesc('Wait this many seconds after a file changes before syncing. Set to 0 to sync immediately.')
		.addText(text => {
			text.setValue(String(plugin.settings.debounceDelay));
			const maximum = Math.floor(2_147_483_647 / 1000);
			configureIntegerInput(text, 0, maximum);
			bindCommittedText(text, () => String(plugin.settings.debounceDelay), async value => {
				if (await persistSettings({ debounceDelay: Number(value) })) plugin.syncRuntime.updateSyncSettings();
			}, value => parseSettingInteger(value, 0, maximum) !== null);
		});

	return cleanup;
}
