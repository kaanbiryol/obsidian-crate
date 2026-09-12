import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';
import type { CrateSettings } from '../../plugin/settings-types';
import { renderSyncInterval } from './sync-interval';
import { renderExclusionsSetting } from './exclusions-setting';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from './input-helpers';
import { createSettingsSectionHeading } from './section-helpers';

export interface SyncSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderSyncSection(context: SyncSectionContext): void {
	const { containerEl, plugin, rerender } = context;
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

	new Setting(containerEl)
		.setName('Automatic sync')
		.setDesc('This device · sync on startup, on resume, after file changes, and at regular intervals. Turn off to sync only from the command palette or sync activity. A running sync will finish.')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.automaticSync)
			.onChange(async automaticSync => {
				if (await persistSettings({ automaticSync })) {
					plugin.syncRuntime.updateSyncSettings();
					rerender();
				}
			}));

	if (plugin.settings.automaticSync) {
		new Setting(containerEl)
			.setName('Sync delay after editing (seconds)')
			.setDesc('This device · wait this many seconds after a file changes before syncing. Set to 0 to sync immediately.')
			.addText(text => {
				text.setValue(String(plugin.settings.debounceDelay));
				const maximum = Math.floor(2_147_483_647 / 1000);
				configureIntegerInput(text, 0, maximum);
				bindCommittedText(text, () => String(plugin.settings.debounceDelay), async value => {
					if (await persistSettings({ debounceDelay: Number(value) })) plugin.syncRuntime.updateSyncSettings();
				}, value => parseSettingInteger(value, 0, maximum) !== null);
			});

		renderSyncInterval(containerEl, () => plugin.settings.syncInterval, async syncInterval => {
			if (await persistSettings({ syncInterval })) plugin.syncRuntime.updateSyncSettings();
		});
	}

	renderExclusionsSetting(containerEl, plugin, async ignorePatterns => {
		if (await persistSettings({ ignorePatterns })) plugin.syncRuntime.updateSyncSettings();
	});

	new Setting(containerEl)
		.setName('Show sync status')
		.setDesc('This device · show sync activity in the status bar.')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.showStatusBar)
			.onChange(async (value) => {
				if (await persistSettings({ showStatusBar: value })) {
					plugin.syncRuntime.updateStatusBar(value);
				}
			}));
}
