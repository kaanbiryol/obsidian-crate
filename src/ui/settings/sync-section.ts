import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { configureSyncLogger, errorMessage } from '../../plugin/logger';
import type { CrateSettings } from '../../plugin/settings-types';
import type { SyncState } from '../../sync/types';
import { createFileSyncProgress, hideFileSyncProgress, runButtonTask, showFileSyncProgress, updateFileSyncProgress } from './action-helpers';
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

	const syncSetting = new Setting(containerEl)
		.setName('Sync now')
		.setDesc(lastSyncDesc)
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
	let previousStatus: SyncState['status'] = plugin.syncRuntime.getState().status;
	const onStateChange = (state: SyncState) => {
		if (state.status === 'syncing') {
			showFileSyncProgress(syncProgress);
		} else {
			hideFileSyncProgress(syncProgress);
			if (previousStatus === 'syncing') {
				rerender();
			}
		}
		previousStatus = state.status;
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
				await persistSettings({ syncOnStartup: value });
			}));

	new Setting(containerEl)
		.setName('Sync when Obsidian resumes')
		.setDesc('Automatically sync when the app comes back into focus or reconnects')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.syncOnResume)
			.onChange(async (value) => {
				await persistSettings({ syncOnResume: value });
			}));

	new Setting(containerEl)
		.setName('Sync interval')
		.setDesc('How often to check for remote changes (seconds, 0 disables)')
		.addText(text => text
			.setValue(String(plugin.settings.syncInterval))
			.onChange(async (value) => {
				const interval = parseInt(value, 10);
				if (!isNaN(interval) && interval >= 0) {
					if (await persistSettings({ syncInterval: interval })) {
						plugin.syncRuntime.updateSyncSettings();
					}
				}
			}));

	new Setting(containerEl)
		.setName('Ignore patterns')
		.setDesc('Files matching these patterns will not be synced (one per line)')
		.addTextArea(text => {
			text
				.setValue(plugin.settings.ignorePatterns.join('\n'))
				.onChange(async (value) => {
					const ignorePatterns = value
						.split('\n')
						.map(p => p.trim())
						.filter(p => p.length > 0);
					if (await persistSettings({ ignorePatterns })) {
						plugin.syncRuntime.updateSyncSettings();
					}
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
				if (await persistSettings({ showStatusBar: value })) {
					plugin.syncRuntime.updateStatusBar(value);
				}
			}));

	new Setting(containerEl)
		.setName('Debounce delay')
		.setDesc('Seconds to wait after a file change before syncing (0 to sync immediately)')
		.addText(text => text
			.setValue(String(plugin.settings.debounceDelay))
			.onChange(async (value) => {
				const delay = parseInt(value, 10);
				if (!isNaN(delay) && delay >= 0) {
					await persistSettings({ debounceDelay: delay });
				}
			}));

	new Setting(containerEl)
		.setName('Debug logging')
		.setDesc('Enable verbose sync logging to the developer console')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.syncDebugLogging)
			.onChange(async (value) => {
				if (await persistSettings({ syncDebugLogging: value })) {
					configureSyncLogger({ enabled: value });
				}
			}));

	return cleanup;
}
