/**
 * Settings tab for Obsidian Crate configuration
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type CratePlugin from '../main';
import { renderConfigSection, type ManualSetupState } from './settings/config-section';
import { renderInfrastructureSection } from './settings/infrastructure-section';
import { renderSyncSection } from './settings/sync-section';
import { renderUsageSection } from './settings/usage-section';

export class CrateSettingTab extends PluginSettingTab {
	plugin: CratePlugin;
	private readonly manualState: ManualSetupState = {
		manualEntryEnabled: false,
		manualAccountId: '',
		manualApiToken: '',
		manualBucketName: '',
		manualWorkerName: '',
	};

	constructor(app: App, plugin: CratePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('crate-settings');

		containerEl.createEl('h2', { text: 'Obsidian Crate settings' });

		renderConfigSection({
			containerEl,
			plugin: this.plugin,
			manualState: this.manualState,
			rerender: () => this.display(),
		});

		if (this.plugin.syncRuntime.isConfigured()) {
			this.renderConnectionSection(containerEl);
			renderUsageSection({
				containerEl,
				plugin: this.plugin,
			});
			renderSyncSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
			renderInfrastructureSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
		}
	}

	private renderConnectionSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Connection' });

		const lastSync = this.plugin.settings.lastSync;
		new Setting(containerEl)
			.setName('Last sync')
			.setDesc(lastSync ? new Date(lastSync).toLocaleString() : 'Never');
	}
}
