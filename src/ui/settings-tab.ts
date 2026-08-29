/**
 * Settings tab for Crate configuration
 */

import { App, PluginSettingTab } from 'obsidian';
import type CratePlugin from '../main';
import { renderConfigSection } from './settings/config-section';
import { renderDevicesSection } from './settings/devices-section';
import { renderInfrastructureSection } from './settings/infrastructure-section';
import { renderSyncSection } from './settings/sync-section';
import { renderRemindersSection } from './settings/reminders-section';
import { renderNotificationsSection } from './settings/notifications-section';
import { createSettingsRootHeading } from './settings/section-helpers';
import { getSettingsTabSections } from './settings/settings-tab-model';

export class CrateSettingTab extends PluginSettingTab {
	plugin: CratePlugin;
	private cleanupFns: (() => void)[] = [];

	constructor(app: App, plugin: CratePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.cleanup();

		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('crate-settings');

		createSettingsRootHeading(containerEl, 'Crate settings');

		const isConfigured = this.plugin.syncRuntime.isConfigured();
		const sections = getSettingsTabSections({
			isConfigured,
		});

		renderConfigSection({
			containerEl,
			plugin: this.plugin,
			rerender: () => this.display(),
		});

		if (isConfigured) {
			renderDevicesSection({
				containerEl,
				plugin: this.plugin,
			});
		}

		if (sections.showSync) {
			const syncCleanup = renderSyncSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
			this.cleanupFns.push(syncCleanup);
		}

		if (sections.showReminders) {
			renderRemindersSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
		}

		if (sections.showNotifications) {
			renderNotificationsSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
		}

		if (sections.showInfrastructure) {
			renderInfrastructureSection({
				containerEl,
				plugin: this.plugin,
				isConfigured,
				rerender: () => this.display(),
			});
		}
	}

	hide(): void {
		void this.plugin.syncRuntime?.pushSharedSettingsBestEffort();
		this.cleanup();
	}

	private cleanup(): void {
		for (const fn of this.cleanupFns) {
			fn();
		}
		this.cleanupFns = [];
	}
}
