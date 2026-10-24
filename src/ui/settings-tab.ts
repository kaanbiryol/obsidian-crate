/**
 * Settings tab for Crate configuration
 */

import { renderAppearanceSettings } from './settings/appearance-section';
import { createSettingsDisclosure } from './plugin/settings-disclosure';
import { createSettingsSectionHeading, type SettingsSection } from './settings/section-helpers';
import { renderUsageSection } from './settings/infrastructure/usage-section';
import { renderConnectionStatus } from './settings/infrastructure/connection-status';
import { App, PluginSettingTab, Setting } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { renderForgetServerSetting } from './settings/infrastructure/server-selection-setting';
import { renderConfigSection, renderServerSection, renderServerUpdateNotice } from './settings/infrastructure/config-section';
import { renderDevicesSection } from './settings/devices-section';
import { renderInfrastructureSection, renderServerActions } from './settings/infrastructure/infrastructure-section';
import { renderSyncSection } from './settings/sync-section';
import { renderRemindersSettings } from '../reminders/ui/plugin/settings-section';
import { renderNotificationsSection } from './settings/notifications-section';
import { renderCrateWebApp } from './settings/reminders-web-app';
import { renderReadingSettings } from '../reading/ui/plugin/settings-section';
import { captureSettingsView, restoreSettingsView } from './settings/settings-view-state';
import { getSettingsTabSections } from './settings/settings-tab-model';
import { createSharedSettingsPush } from './settings/shared-settings-push';

export class CrateSettingTab extends PluginSettingTab {
	plugin: CratePlugin;
	private cleanupFns: (() => void)[] = [];
	private readonly sharedSettings: ReturnType<typeof createSharedSettingsPush>;

	constructor(app: App, plugin: CratePlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.sharedSettings = createSharedSettingsPush(plugin);
	}

	display(): void {
		this.cleanup();
		this.sharedSettings.observe();

		const { containerEl } = this;
		const viewState = captureSettingsView(containerEl);
		containerEl.empty();
		containerEl.addClass('crate-settings');

		const isConfigured = this.plugin.syncRuntime.isConfigured();
		const sections = getSettingsTabSections({
			isConfigured,
			hasDeployment: Boolean(this.plugin.settings.cloudflareDeployment?.d1DatabaseId),
		});

		this.renderSection(renderServerUpdateNotice, containerEl);

		if (!isConfigured) {
			new Setting(containerEl).setName('Plugin version').setDesc(this.plugin.manifest.version);
			this.renderSection(renderConfigSection, containerEl);
			this.renderSection(renderForgetServerSetting, containerEl);
		}
		if (isConfigured) {
			createSettingsSectionHeading(containerEl, 'Sync');
			this.renderSection(renderConnectionStatus, containerEl);
		}

		if (sections.showSync) {
			this.renderSection(renderSyncSection, containerEl);
		}

		if (isConfigured) {
			this.renderSection(renderCrateWebApp, containerEl);
			this.renderSection(renderAppearanceSettings, containerEl);
		}

		if (sections.showReminders || sections.showReading || sections.showNotifications) {
			createSettingsSectionHeading(containerEl, 'Features');
		}

		if (sections.showReminders) {
			this.renderSection(renderRemindersSettings, containerEl.createDiv({ cls: 'crate-reminders-settings' }));
		}

		if (sections.showReading) {
			this.renderSection(renderReadingSettings, containerEl);
		}

		if (sections.showNotifications) {
			this.renderSection(renderNotificationsSection, containerEl);
		}

		if (isConfigured || sections.showInfrastructure) {
			createSettingsSectionHeading(containerEl, 'Management');
		}

		if (isConfigured) {
			createSettingsDisclosure(containerEl, 'Account and devices', {
				summary: this.plugin.settings.cloudflareDeployment?.accountName ?? 'Connection and sessions',
				onOpen: accountEl => {
					this.renderSection(context => renderConfigSection(context, false), accountEl);
					this.renderSection(renderDevicesSection, accountEl);
				},
			});
			if (this.plugin.settings.cloudflareDeployment?.accountId) {
				createSettingsDisclosure(containerEl, 'Usage', {
					summary: 'Cloudflare account usage and allowances',
					onOpen: content => {
						this.renderSection(renderUsageSection, content);
					},
				});
			}
			const serverEl = createSettingsDisclosure(containerEl, 'Server', {
				summary: 'Versions, backups, and management',
				onOpen: content => {
					this.renderSection(renderServerSection, content);
					this.renderSection(context => renderServerActions({ ...context, isConfigured }), content);
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
			this.renderSection(context => renderInfrastructureSection({ ...context, isConfigured }), containerEl);
		}
		restoreSettingsView(containerEl, viewState);

	}

	private renderSection(section: SettingsSection, containerEl: HTMLElement): void {
		const cleanup = section({ containerEl, plugin: this.plugin, rerender: () => this.update() });
		if (cleanup) this.cleanupFns.push(cleanup);
	}

	hide(): void {
		void this.sharedSettings.push();
		this.cleanup();
	}

	private cleanup(): void {
		for (const fn of this.cleanupFns) {
			fn();
		}
		this.cleanupFns = [];
	}
}
