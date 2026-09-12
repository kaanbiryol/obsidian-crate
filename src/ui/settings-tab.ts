/**
 * Settings tab for Crate configuration
 */

import { renderConnectionStatus } from './settings/connection-status';
import { App, PluginSettingTab } from 'obsidian';
import type CratePlugin from '../main';
import { renderConfigSection, renderDisconnectSetting } from './settings/config-section';
import { renderDevicesSection } from './settings/devices-section';
import { renderInfrastructureSection } from './settings/infrastructure-section';
import { renderSyncSection } from './settings/sync-section';
import { renderRemindersSection } from './settings/reminders-section';
import { renderNotificationsSection } from './settings/notifications-section';
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
		const openSections = new Map(Array.from(containerEl.querySelectorAll<HTMLDetailsElement>('details'))
			.map(details => [details.querySelector('summary')?.textContent, details.open]));
		containerEl.empty();
		containerEl.addClass('crate-settings');

		const isConfigured = this.plugin.syncRuntime.isConfigured();
		const sections = getSettingsTabSections({
			isConfigured,
			hasDeployment: Boolean(this.plugin.settings.cloudflareDeployment?.d1DatabaseId),
		});

		renderConfigSection({
			containerEl,
			plugin: this.plugin,
			rerender: () => this.update(),
		});

		if (isConfigured) this.cleanupFns.push(renderConnectionStatus(containerEl, this.plugin));

		if (sections.showSync) {
			renderSyncSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			});
		}

		if (sections.showReminders) {
			this.cleanupFns.push(renderRemindersSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			}));
		}

		if (sections.showNotifications) {
			renderNotificationsSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			});
		}

		if (isConfigured) {
			this.cleanupFns.push(renderDevicesSection({
				containerEl,
				plugin: this.plugin,
			}));
		}

		if (sections.showInfrastructure) {
			renderInfrastructureSection({
				containerEl,
				plugin: this.plugin,
				isConfigured,
				rerender: () => this.update(),
			});
		}
		if (isConfigured) renderDisconnectSetting({ containerEl, plugin: this.plugin, rerender: () => this.update() });
		for (const details of Array.from(containerEl.querySelectorAll<HTMLDetailsElement>('details'))) {
			const previous = openSections.get(details.querySelector('summary')?.textContent);
			if (previous !== undefined) details.open = previous;
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
