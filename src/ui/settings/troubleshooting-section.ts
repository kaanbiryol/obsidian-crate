import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { errorMessage } from '../../plugin/logger';

export function renderTroubleshootingSettings(containerEl: HTMLElement, plugin: CratePlugin): void {
	new Setting(containerEl)
		.setName('Debug logging')
		.setDesc('Write detailed sync and reminder logs to the developer console for troubleshooting.')
		.addToggle(toggle => toggle.setValue(plugin.settings.debugLogging).onChange(async value => {
			toggle.setDisabled(true);
			try {
				await plugin.setDebugLogging(value);
			} catch (error) {
				new Notice(`Could not save logging settings: ${errorMessage(error)}`);
			} finally {
				toggle.setValue(plugin.settings.debugLogging);
				toggle.setDisabled(false);
			}
		}));
}
