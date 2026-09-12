import { Notice, Setting, type TextComponent } from 'obsidian';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from './input-helpers';

const PRESETS = new Map([[0, 'Off'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes']]);
// Browser timers use signed 32-bit milliseconds.
const MAX_INTERVAL = Math.floor(2_147_483_647 / 1000);

export function renderSyncInterval(
	containerEl: HTMLElement,
	currentValue: () => number,
	save: (seconds: number) => Promise<void>,
): void {
	let customInput: TextComponent;
	const setting = new Setting(containerEl)
		.setName('Check for changes')
		.setDesc('All devices · how often to check for changes. Off stops periodic checks; edits, startup, and resume can still sync. Custom values are in seconds.')
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
			configureIntegerInput(text, 0, MAX_INTERVAL);
			text.inputEl.setAttribute('aria-label', 'Custom check interval in seconds');
			text.inputEl.hidden = PRESETS.has(currentValue());
			bindCommittedText(text, () => String(currentValue()), value => save(Number(value)),
				value => parseSettingInteger(value, 0, MAX_INTERVAL) !== null);
		});
	setting.settingEl.addClass('crate-sync-interval');
}
