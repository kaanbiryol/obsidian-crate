/**
 * Settings tab for Obsidian Crate configuration
 */

import { App, PluginSettingTab, Setting, Notice, TextAreaComponent } from 'obsidian';
import type CratePlugin from '../main';
import { SECRET_KEYS } from '../types';
import type { CrateConfig } from '../types';

export class CrateSettingTab extends PluginSettingTab {
	plugin: CratePlugin;

	constructor(app: App, plugin: CratePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Obsidian Crate Settings' });

		// Configuration section
		this.renderConfigSection(containerEl);

		// Only show remaining sections if configured
		if (this.plugin.isConfigured()) {
			this.renderConnectionSection(containerEl);
			this.renderSyncSection(containerEl);
			this.renderAdvancedSection(containerEl);
		}
	}

	private renderConfigSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Configuration' });

		if (!this.plugin.isConfigured()) {
			containerEl.createEl('p', {
				text: 'Paste the configuration from the CLI tool to get started.',
				cls: 'setting-item-description',
			});

			let configInput: TextAreaComponent;

			new Setting(containerEl)
				.setName('Configuration')
				.setDesc('Paste the JSON output from "crate init" here')
				.addTextArea(text => {
					configInput = text;
					text
						.setPlaceholder('{"workerUrl": "...", "token": "..."}')
						.setValue('');
					text.inputEl.rows = 4;
					text.inputEl.cols = 50;
				})
				.addButton(button => button
					.setButtonText('Apply')
					.setCta()
					.onClick(async () => {
						const value = configInput.getValue().trim();
						if (!value) {
							new Notice('Please paste the configuration first');
							return;
						}

						try {
							const config = JSON.parse(value) as CrateConfig;

							if (!config.workerUrl || !config.token) {
								new Notice('Invalid configuration: missing workerUrl or token');
								return;
							}

							// Save configuration
							this.plugin.settings.workerUrl = config.workerUrl;
							await this.plugin.saveSettings();
							this.plugin.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, config.token);

							// Reinitialize plugin
							await this.plugin.initializeSync();

							new Notice('Configuration saved successfully!');
							this.display(); // Refresh the settings view
						} catch (e) {
							new Notice('Invalid JSON configuration');
						}
					}));
		} else {
			new Setting(containerEl)
				.setName('Worker URL')
				.setDesc('The Cloudflare Worker URL for sync')
				.addText(text => text
					.setValue(this.plugin.settings.workerUrl)
					.setDisabled(true));

			new Setting(containerEl)
				.setName('Reset Configuration')
				.setDesc('Clear the current configuration to set up a new connection')
				.addButton(button => button
					.setButtonText('Reset')
					.setWarning()
					.onClick(async () => {
						if (confirm('Are you sure you want to reset the configuration?')) {
							this.plugin.settings.workerUrl = '';
							await this.plugin.saveSettings();
							this.plugin.secretStorage.delete(SECRET_KEYS.AUTH_TOKEN);
							new Notice('Configuration cleared');
							this.display();
						}
					}));
		}
	}

	private renderConnectionSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Connection' });

		new Setting(containerEl)
			.setName('Test Connection')
			.setDesc('Verify that the plugin can connect to your sync server')
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing...');

					try {
						const result = await this.plugin.testConnection();
						if (result.success) {
							new Notice('Connection successful!');
						} else {
							new Notice(`Connection failed: ${result.error}`);
						}
					} catch (e) {
						new Notice('Connection test failed');
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test');
					}
				}));

		const lastSync = this.plugin.settings.lastSync;
		new Setting(containerEl)
			.setName('Last Sync')
			.setDesc(lastSync ? new Date(lastSync).toLocaleString() : 'Never');
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Sync' });

		new Setting(containerEl)
			.setName('Sync Now')
			.setDesc('Manually trigger a full sync')
			.addButton(button => button
				.setButtonText('Sync Now')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Syncing...');

					try {
						const result = await this.plugin.sync();
						if (result.success) {
							new Notice(`Sync complete: ${result.uploaded} uploaded, ${result.downloaded} downloaded`);
						} else {
							new Notice(`Sync completed with errors: ${result.errors.join(', ')}`);
						}

						if (result.conflicts.length > 0) {
							new Notice(`${result.conflicts.length} conflict(s) created`);
						}
					} catch (e) {
						new Notice('Sync failed');
					} finally {
						button.setDisabled(false);
						button.setButtonText('Sync Now');
						this.display(); // Refresh to show updated last sync time
					}
				}));

		new Setting(containerEl)
			.setName('Sync on Startup')
			.setDesc('Automatically sync when Obsidian starts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Interval')
			.setDesc('How often to check for remote changes (in seconds, 0 to disable)')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncInterval))
				.onChange(async (value) => {
					const interval = parseInt(value, 10);
					if (!isNaN(interval) && interval >= 0) {
						this.plugin.settings.syncInterval = interval;
						await this.plugin.saveSettings();
						this.plugin.updateSyncSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Show Status Bar')
			.setDesc('Display sync status in the status bar')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStatusBar)
				.onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBar(value);
				}));
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Advanced' });

		new Setting(containerEl)
			.setName('Device ID')
			.setDesc('Unique identifier for this device')
			.addText(text => text
				.setValue(this.plugin.settings.deviceId)
				.onChange(async (value) => {
					this.plugin.settings.deviceId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Ignore Patterns')
			.setDesc('Files matching these patterns will not be synced (one per line)')
			.addTextArea(text => {
				text
					.setValue(this.plugin.settings.ignorePatterns.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.ignorePatterns = value
							.split('\n')
							.map(p => p.trim())
							.filter(p => p.length > 0);
						await this.plugin.saveSettings();
						this.plugin.updateSyncSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.cols = 40;
			});

		const initialSyncSetting = new Setting(containerEl)
			.setName('Initial Sync')
			.setDesc('Upload all local files to the server (use for first-time setup)')
			.addButton(button => button
				.setButtonText('Upload All')
				.setWarning()
				.onClick(async () => {
					if (!confirm('This will upload all files in your vault to the server. Continue?')) {
						return;
					}

					button.setDisabled(true);
					button.setButtonText('Uploading...');
					progressContainer.style.display = 'block';
					progressFill.style.width = '0%';

					try {
						const result = await this.plugin.initialSync((current, total) => {
							button.setButtonText(`Uploading... ${current}/${total}`);
							const pct = Math.round((current / total) * 100);
							progressFill.style.width = `${pct}%`;
							progressLabel.textContent = `${current} / ${total} files`;
						});

						if (result.success) {
							new Notice(`Initial sync complete: ${result.uploaded} files uploaded`);
						} else {
							new Notice(`Initial sync completed with errors`);
						}
					} catch (e) {
						new Notice('Initial sync failed');
					} finally {
						button.setDisabled(false);
						button.setButtonText('Upload All');
						progressContainer.style.display = 'none';
						progressFill.style.width = '0%';
						this.display();
					}
				}));

		const progressContainer = initialSyncSetting.settingEl.createDiv({ cls: 'crate-sync-progress' });
		progressContainer.style.display = 'none';
		const progressLabel = progressContainer.createDiv({ cls: 'crate-sync-progress-label' });
		const progressBar = progressContainer.createDiv({ cls: 'crate-sync-progress-bar' });
		const progressFill = progressBar.createDiv({ cls: 'crate-sync-progress-fill' });
	}
}
