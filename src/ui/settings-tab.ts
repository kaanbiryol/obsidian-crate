/**
 * Settings tab for Crate configuration
 */

import { renderAppearanceSettings } from './settings/appearance-section';
import { createSettingsDisclosure, createSettingsSectionHeading } from './settings/section-helpers';
import { renderUsageSection } from './settings/usage-section';
import { renderConnectionStatus } from './settings/connection-status';
import { App, PluginSettingTab, Setting } from 'obsidian';
import type CratePlugin from '../main';
import { renderForgetServerSetting } from './settings/server-selection-setting';
import { renderConfigSection, renderServerSection, renderServerUpdateNotice } from './settings/config-section';
import { renderDevicesSection } from './settings/devices-section';
import { renderInfrastructureSection, renderServerActions } from './settings/infrastructure-section';
import { renderSyncSection } from './settings/sync-section';
import { renderRemindersSection } from './settings/reminders-section';
import { renderNotificationsSection } from './settings/notifications-section';
import { renderCrateWebApp } from './settings/reminders-web-app';
import { renderReadingSettings } from '../reading/ui/settings-section';
import { captureSettingsView, restoreSettingsView } from './settings/settings-view-state';
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
		const viewState = captureSettingsView(containerEl);
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
			this.cleanupFns.push(renderSyncSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			}));
		}

		if (isConfigured) {
			renderCrateWebApp(containerEl, this.plugin);
			renderAppearanceSettings({ containerEl, plugin: this.plugin, rerender: () => this.update() });
		}

		if (sections.showReminders || sections.showReading || sections.showNotifications) {
			createSettingsSectionHeading(containerEl, 'Features');
		}

		if (sections.showReminders) {
			const remindersEl = containerEl.createDiv({ cls: 'crate-reminders-settings' });
			this.cleanupFns.push(renderRemindersSection({
				containerEl: remindersEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			}));
		}

		if (sections.showReading) {
			this.cleanupFns.push(renderReadingSettings(containerEl, this.plugin, () => this.update()));
		}

		if (sections.showNotifications) {
			this.cleanupFns.push(renderNotificationsSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.update(),
			}));
		}

		if (isConfigured || sections.showInfrastructure) {
			createSettingsSectionHeading(containerEl, 'Management');
		}

		if (isConfigured) {
			createSettingsDisclosure(containerEl, 'Account and devices', {
				summary: this.plugin.settings.cloudflareDeployment?.accountName ?? 'Connection and sessions',
				onOpen: accountEl => {
					renderConfigSection({ containerEl: accountEl, plugin: this.plugin, rerender: () => this.update() }, false);
					this.cleanupFns.push(renderDevicesSection({ containerEl: accountEl, plugin: this.plugin }));
				},
			});
			const serverEl = createSettingsDisclosure(containerEl, 'Server', {
				summary: 'Versions, usage, backups, and management',
				onOpen: content => {
					renderServerSection({ containerEl: content, plugin: this.plugin, rerender: () => this.update() });
					this.cleanupFns.push(renderUsageSection(content, this.plugin));
					renderServerActions({ containerEl: content, plugin: this.plugin, isConfigured, rerender: () => this.update() });
				},
			});
			if (this.plugin.settings.cloudflareDeployment?.reset || this.plugin.settings.cloudflareRestore && this.plugin.settings.cloudflareRestore.phase !== 'complete') {
				const attention = new Setting(containerEl).setName('Server recovery needs attention')
					.setDesc('Review the saved server recovery operation.');
				attention.addButton(button => button.setButtonText('Review recovery').onClick(() => {
					const details = serverEl.parentElement as HTMLDetailsElement;
					details.open = true;
					details.dispatchEvent(new Event('toggle'));
					details.querySelector('summary')?.focus();
				}));
				containerEl.prepend(attention.settingEl);
			}
		}

		if (sections.showInfrastructure) {
			renderInfrastructureSection({
				containerEl,
				plugin: this.plugin,
				isConfigured,
				rerender: () => this.update(),
			});
		}
		restoreSettingsView(containerEl, viewState);

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
