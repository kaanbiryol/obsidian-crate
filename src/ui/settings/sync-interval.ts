import { Notice, Setting, type TextComponent } from 'obsidian';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from './input-helpers';
import { MAX_SYNC_INTERVAL_SECONDS } from '../../protocol/shared-settings';

const PRESETS = new Map([[0, 'Off'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes']]);

export function renderSyncInterval(
	containerEl: HTMLElement,
	currentValue: () => number,
	save: (seconds: number) => Promise<void>,
): void {
	let customInput: TextComponent;
	const setting = new Setting(containerEl)
		.setName('Check for remote changes')
		.setDesc('All devices · how often to check for changes when automatic sync is on. Off stops periodic checks; edits, startup, and resume can still sync. Custom values are in seconds.')
		.addDropdown(dropdown => {
			for (const [seconds, label] of PRESETS) dropdown.addOption(String(seconds), label);
			dropdown.addOption('custom', 'Custom');
			dropdown.setValue(PRESETS.has(currentValue()) ? String(currentValue()) : 'custom');
			dropdown.onChange(async value => {
				customInput.inputEl.hidden = value !== 'custom';
				if (value === 'custom') {
					customInput.inputEl.focus();
					return;
				}
				dropdown.setDisabled(true);
				try {
					await save(Number(value));
				} catch {
					new Notice('Could not save the check interval. Please try again.');
				} finally {
					dropdown.setValue(PRESETS.has(currentValue()) ? String(currentValue()) : 'custom');
					customInput.setValue(String(currentValue()));
					customInput.inputEl.hidden = PRESETS.has(currentValue());
					dropdown.setDisabled(false);
				}
			});
		})
		.addText(text => {
			customInput = text;
			text.setValue(String(currentValue()));
			configureIntegerInput(text, 0, MAX_SYNC_INTERVAL_SECONDS);
			text.inputEl.setAttribute('aria-label', 'Custom check interval in seconds');
			text.inputEl.hidden = PRESETS.has(currentValue());
			bindCommittedText(text, () => String(currentValue()), value => save(Number(value)),
				value => parseSettingInteger(value, 0, MAX_SYNC_INTERVAL_SECONDS) !== null);
		});
	setting.settingEl.addClass('crate-sync-interval');
}
