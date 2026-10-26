import { Notice, Setting } from 'obsidian';
import { errorMessage } from '../../platform/logger';
import type { CrateSettings } from '../../plugin/settings-types';
import { createSettingsDisclosure } from '../plugin/settings-disclosure';
import { renderSyncInterval } from './sync-interval';
import { renderEncryptionSection } from './encryption/encryption-section';
import { renderExclusionsSetting } from './exclusions-setting';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from './input-helpers';
import { MAX_TIMER_SECONDS } from '../../protocol/shared-settings';
import { writeSyncSettings } from '../../plugin/sync-connection';
import type { SettingsSectionContext } from './section-helpers';

export function renderSyncSection(context: SettingsSectionContext): () => void {
	const { containerEl, plugin, rerender } = context;
	const cleanup = renderEncryptionSection(containerEl, plugin);
	const persistSettings = async (update: Partial<CrateSettings>): Promise<boolean> => {
		try {
			await writeSyncSettings(plugin, update);
			return true;
		} catch (error) {
			new Notice(`Failed to save sync settings: ${errorMessage(error)}`);
			rerender();
			return false;
		}
	};


	new Setting(containerEl)
		.setName('Automatic sync')
		.setDesc('This device · sync after edits, on startup and resume, and at the chosen interval. Turning this off lets a running sync finish.')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.automaticSync)
			.onChange(async automaticSync => {
				if (await persistSettings({ automaticSync })) rerender();
			}));

	const options = createSettingsDisclosure(containerEl, 'Sync options', { summary: plugin.settings.automaticSync ? `After edits: ${plugin.settings.debounceDelay}s · Interval: ${plugin.settings.syncInterval}s` : 'Excluded files' });

	if (plugin.settings.automaticSync) {
		new Setting(options)
			.setName('Sync delay after editing (seconds)')
			.setDesc('This device · when automatic sync is on, wait this many seconds after a file changes before syncing. Set to 0 to sync immediately.')
			.addText(text => {
				text.setValue(String(plugin.settings.debounceDelay));
				configureIntegerInput(text, 0, MAX_TIMER_SECONDS);
				bindCommittedText(text, () => String(plugin.settings.debounceDelay), async value => {
					if (await persistSettings({ debounceDelay: Number(value) })) rerender();
				}, value => parseSettingInteger(value, 0, MAX_TIMER_SECONDS) !== null);
			});

		renderSyncInterval(options, () => plugin.settings.syncInterval, async syncInterval => {
			if (await persistSettings({ syncInterval })) rerender();
		});
	}

	new Setting(options)
		.setName('Plugins and settings')
		.setDesc('Other plugins and their settings sync with your vault. Settings can contain credentials or device-specific values; exclude any files you want to keep local below. Restart Obsidian after syncing to load changes. Crate itself stays local.');

	renderExclusionsSetting(options, plugin, async ignorePatterns => {
		await persistSettings({ ignorePatterns });
	});
	return cleanup;
}
