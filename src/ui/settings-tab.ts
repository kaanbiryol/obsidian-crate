/**
 * Settings tab for Crate configuration
 */

import { createSettingsDisclosure, createSettingsSectionHeading } from './settings/section-helpers';
import { renderUsageSection } from './settings/usage-section';
import { renderConnectionStatus } from './settings/connection-status';
import { App, PluginSettingTab, Setting } from 'obsidian';
import type CratePlugin from '../main';
import { renderForgetServerSetting } from './settings/server-selection-setting';
import { renderConfigSection, renderServerSection, renderServerUpdateNotice } from './settings/config-section';
import { renderDevicesSection } from './settings/devices-section';
import { renderInfrastructureSection } from './settings/infrastructure-section';
import { renderSyncSection } from './settings/sync-section';
import { renderRemindersSection } from './settings/reminders-section';
import { renderNotificationsSection } from './settings/notifications-section';
import { renderReadingSettings } from '../reading/ui/settings-section';
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

		renderServerUpdateNotice({ containerEl, plugin: this.plugin, rerender: () => this.update() });

		if (!isConfigured) {
			new Setting(containerEl).setName('Plugin version').setDesc(this.plugin.manifest.version);
			renderConfigSection({ containerEl, plugin: this.plugin, rerender: () => this.update() });
			renderForgetServerSetting({ containerEl, plugin: this.plugin, rerender: () => this.update() });
		}
		if (isConfigured) {
			createSettingsSectionHeading(containerEl, 'Sync');
			this.cleanupFns.push(renderConnectionStatus(containerEl, this.plugin));
		}

		if (sections.showSync) {
			renderSyncSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			});
		}

		if (sections.showReminders) {
			const remindersEl = containerEl.createDiv({ cls: 'crate-reminders-settings' });
			let allDayTimeEl: HTMLElement | undefined;
			this.cleanupFns.push(renderRemindersSection({
				onAllDayTimeContainer: container => { allDayTimeEl = container; },
				containerEl: remindersEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			}));
			if (sections.showNotifications) {
				this.cleanupFns.push(renderNotificationsSection({
					allDayTimeContainerEl: allDayTimeEl,
					containerEl: remindersEl,
					plugin: this.plugin,
					rerender: () => this.update(),
				}));
			}
		}

		renderReadingSettings(containerEl, this.plugin, () => this.update());

		if (isConfigured) {
			const accountEl = createSettingsDisclosure(containerEl, 'Account and devices');
			renderConfigSection({ containerEl: accountEl, plugin: this.plugin, rerender: () => this.update() }, false);
			this.cleanupFns.push(renderDevicesSection({ containerEl: accountEl, plugin: this.plugin }));
			const serverEl = createSettingsDisclosure(containerEl, 'Server and usage');
			renderServerSection({ containerEl: serverEl, plugin: this.plugin, rerender: () => this.update() });
			this.cleanupFns.push(renderUsageSection(serverEl, this.plugin));
		}

		if (sections.showInfrastructure) {
			renderInfrastructureSection({
				containerEl,
				plugin: this.plugin,
				isConfigured,
				rerender: () => this.update(),
			});
		}
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
