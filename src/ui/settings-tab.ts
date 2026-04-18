/**
 * Settings tab for Crate configuration
 */

import { App, PluginSettingTab } from 'obsidian';
import type CratePlugin from '../main';
import { renderConfigSection, type SetupWizardState } from './settings/config-section';
import { renderInfrastructureSection } from './settings/infrastructure-section';
import { renderSyncSection } from './settings/sync-section';
import { renderUsageSection } from './settings/usage-section';
import { renderRemindersSection } from './settings/reminders-section';
import { renderNotificationsSection } from './settings/notifications-section';
import { createSettingsRootHeading } from './settings/section-helpers';
import { getSettingsTabSections } from './settings/settings-tab-model';

export class CrateSettingTab extends PluginSettingTab {
	plugin: CratePlugin;
	private readonly wizardState: SetupWizardState = {
		wizardToken: '',
		wizardTokenValidated: false,
		wizardSelectedAccountId: '',
	};
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
		const hasCloudflareCredentials = this.plugin.cloudflareSession.hasCredentials();
		const sections = getSettingsTabSections({
			isConfigured,
			hasCloudflareCredentials,
		});

		renderConfigSection({
			containerEl,
			plugin: this.plugin,
			wizardState: this.wizardState,
			rerender: () => this.display(),
		});

		if (sections.showSync) {
			const syncCleanup = renderSyncSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
			this.cleanupFns.push(syncCleanup);
		}

		renderRemindersSection({
			containerEl,
			plugin: this.plugin,
			rerender: () => this.display(),
		});

		if (sections.showNotifications) {
			renderNotificationsSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
		}

		if (sections.showUsage) {
			renderUsageSection({
				containerEl,
				plugin: this.plugin,
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
		this.plugin.syncRuntime?.pushSharedSettings().catch(() => {});
		this.cleanup();
	}

	private cleanup(): void {
		for (const fn of this.cleanupFns) {
			fn();
		}
		this.cleanupFns = [];
	}
}
