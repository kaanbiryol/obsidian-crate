import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { configureSyncLogger, errorMessage } from '../../plugin/logger';

export function renderTroubleshootingSettings(containerEl: HTMLElement, plugin: CratePlugin): void {
	new Setting(containerEl)
		.setName('Device ID')
		.setDesc('Identifies this device during sync. Stored only on this device.')
		.addText(text => {
			text.setValue(plugin.settings.deviceId);
			text.inputEl.readOnly = true;
		})
		.addButton(button => button.setButtonText('Copy').onClick(async () => {
			try {
				await navigator.clipboard.writeText(plugin.settings.deviceId);
				new Notice('Device ID copied');
			} catch {
				new Notice('Could not copy the device ID');
			}
		}));

	new Setting(containerEl)
		.setName('Sync debug logging')
		.setDesc('Write detailed sync logs to the developer console for troubleshooting.')
		.addToggle(toggle => toggle.setValue(plugin.settings.syncDebugLogging).onChange(async value => {
			try {
				await plugin.writeSettings({ syncDebugLogging: value });
				configureSyncLogger({ enabled: value });
			} catch (error) {
				new Notice(`Could not save logging settings: ${errorMessage(error)}`);
				toggle.setValue(plugin.settings.syncDebugLogging);
			}
		}));
	new Setting(containerEl)
		.setName('Reminders debug logging')
		.setDesc('Write detailed reminder logs to the developer console for troubleshooting.')
		.addToggle(toggle => toggle.setValue(plugin.remindersSettings.debugLogging).onChange(async value => {
			try {
				await plugin.writeRemindersSettings({ debugLogging: value });
			} catch (error) {
				new Notice(`Could not save logging settings: ${errorMessage(error)}`);
				toggle.setValue(plugin.remindersSettings.debugLogging);
			}
		}));
}
