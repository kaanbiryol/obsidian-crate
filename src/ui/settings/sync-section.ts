import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import type { SyncState } from '../../types';
import { createFileSyncProgress, hideFileSyncProgress, runButtonTask, showFileSyncProgress, updateFileSyncProgress } from './action-helpers';

export interface SyncSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderSyncSection(context: SyncSectionContext): () => void {
	const { containerEl, plugin, rerender } = context;
	const isSyncing = plugin.syncRuntime.getState().status === 'syncing';

	containerEl.createEl('h3', { text: 'Sync' });

	const lastSync = plugin.settings.lastSync;
	const lastSyncSetting = new Setting(containerEl)
		.setName('Last sync')
		.setDesc(lastSync ? new Date(lastSync).toLocaleString() : 'Never');

	if (isSyncing) {
		lastSyncSetting.setDesc('Sync in progress...');
	}

	const syncSetting = new Setting(containerEl)
		.setName('Sync now')
		.setDesc('Manually trigger a full sync')
		.addButton(button => {
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
					onFinally: () => {
						rerender();
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
			rerender();
		}
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
		.setDesc('Automatically sync when Obsidian starts')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.syncOnStartup)
			.onChange(async (value) => {
				plugin.settings.syncOnStartup = value;
				await plugin.saveSettings();
			}));

	new Setting(containerEl)
		.setName('Sync interval')
		.setDesc('How often to check for remote changes (seconds, 0 disables)')
		.addText(text => text
			.setValue(String(plugin.settings.syncInterval))
			.onChange(async (value) => {
				const interval = parseInt(value, 10);
				if (!isNaN(interval) && interval >= 0) {
					plugin.settings.syncInterval = interval;
					await plugin.saveSettings();
					plugin.syncRuntime.updateSyncSettings();
				}
			}));

	new Setting(containerEl)
		.setName('Ignore patterns')
		.setDesc('Files matching these patterns will not be synced (one per line)')
		.addTextArea(text => {
			text
				.setValue(plugin.settings.ignorePatterns.join('\n'))
				.onChange(async (value) => {
					plugin.settings.ignorePatterns = value
						.split('\n')
						.map(p => p.trim())
						.filter(p => p.length > 0);
					await plugin.saveSettings();
					plugin.syncRuntime.updateSyncSettings();
				});
			text.inputEl.rows = 6;
			text.inputEl.cols = 40;
		});

	new Setting(containerEl)
		.setName('Show status bar')
		.setDesc('Display sync status in the status bar')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.showStatusBar)
			.onChange(async (value) => {
				plugin.settings.showStatusBar = value;
				await plugin.saveSettings();
				plugin.syncRuntime.updateStatusBar(value);
			}));

	return cleanup;
}
