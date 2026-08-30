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
