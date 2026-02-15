/**
 * Settings tab for Obsidian Crate configuration
 */

import { App, PluginSettingTab } from 'obsidian';
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

		containerEl.createEl('h2', { text: 'Obsidian Crate settings' });

		renderConfigSection({
			containerEl,
			plugin: this.plugin,
			manualState: this.manualState,
			rerender: () => this.display(),
		});

		if (this.plugin.syncRuntime.isConfigured()) {
			const syncCleanup = renderSyncSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
			this.cleanupFns.push(syncCleanup);

			renderInfrastructureSection({
				containerEl,
				plugin: this.plugin,
				rerender: () => this.display(),
			});
			renderUsageSection({
				containerEl,
				plugin: this.plugin,
			});
		}
	}

	hide(): void {
		this.cleanup();
	}

	private cleanup(): void {
		for (const fn of this.cleanupFns) {
			fn();
		}
		this.cleanupFns = [];
	}
}
