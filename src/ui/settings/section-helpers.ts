import { Setting } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';

/** Where a settings section renders and how it asks the settings tab to render again. */
export interface SettingsSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

/** Renders one settings tab section; returns a cleanup when it holds subscriptions or timers. */
export type SettingsSection = (context: SettingsSectionContext) => (() => void) | void;

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
