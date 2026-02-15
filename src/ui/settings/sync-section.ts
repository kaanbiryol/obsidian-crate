import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { runButtonTask } from './action-helpers';

export interface SyncSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderSyncSection(context: SyncSectionContext): void {
	const { containerEl, plugin, rerender } = context;

	containerEl.createEl('h3', { text: 'Sync' });

	new Setting(containerEl)
		.setName('Sync now')
		.setDesc('Manually trigger a full sync')
		.addButton(button => button
			.setButtonText('Sync now')
			.setCta()
			.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Sync now',
					runningText: 'Syncing...',
					task: async () => plugin.syncRuntime.sync(),
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
			}));

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
		.setName('Show status bar')
		.setDesc('Display sync status in the status bar')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.showStatusBar)
			.onChange(async (value) => {
				plugin.settings.showStatusBar = value;
				await plugin.saveSettings();
				plugin.syncRuntime.updateStatusBar(value);
			}));
}
