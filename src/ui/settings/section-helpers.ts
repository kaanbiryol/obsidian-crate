import { Setting } from 'obsidian';

export function createSettingsSectionHeading(containerEl: HTMLElement, title: string): Setting {
	return new Setting(containerEl)
		.setName(title)
		.setHeading()
		.setClass('crate-settings-section-heading');
}

export function createSettingsSubsectionHeading(containerEl: HTMLElement, title: string): Setting {
	return new Setting(containerEl)
		.setName(title)
		.setHeading()
		.setClass('crate-settings-subsection-heading');
}

export function createSettingsDisclosure(containerEl: HTMLElement, title: string): HTMLElement {
	const details = containerEl.createEl('details', { cls: 'crate-settings-disclosure' });
	details.createEl('summary', { text: title });
	return details.createDiv();
}
