/**
 * Settings tab for Obsidian Crate configuration
 */

import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type CratePlugin from '../main';
import { SECRET_KEYS } from '../types';
import type { UsageMetric } from '../types';

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
			this.renderUsageSection(containerEl);
			this.renderSyncSection(containerEl);
			this.renderAdvancedSection(containerEl);
		}
	}

	private renderConfigSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Configuration' });

		if (!this.plugin.isConfigured()) {
			containerEl.createEl('p', {
				text: 'Enter the Worker URL and auth token from the CLI tool to get started.',
				cls: 'setting-item-description',
			});

			let workerUrlInput = this.plugin.settings.workerUrl.trim();
			let authTokenInput = (this.plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || '').trim();

			new Setting(containerEl)
				.setName('Worker URL')
				.setDesc('Paste the Worker URL shown by "crate init"')
				.addText(text => {
					text
						.setPlaceholder('https://your-worker.your-subdomain.workers.dev')
						.setValue(workerUrlInput)
						.onChange(value => {
							workerUrlInput = value.trim();
						});
					text.inputEl.size = 50;
				});

			new Setting(containerEl)
				.setName('Auth token')
				.setDesc('Paste the auth token shown by "crate init"')
				.addText(text => {
					text.inputEl.type = 'password';
					text
						.setPlaceholder('Paste your auth token')
						.setValue(authTokenInput)
						.onChange(value => {
							authTokenInput = value.trim();
						});
					text.inputEl.size = 50;
				});

			new Setting(containerEl)
				.setName('Apply configuration')
				.setDesc('Save these values and connect to your sync server')
				.addButton(button => button
					.setButtonText('Apply')
					.setCta()
					.onClick(async () => {
						const workerUrl = workerUrlInput.trim();
						const token = authTokenInput.trim();

						if (!workerUrl || !token) {
							new Notice('Please enter both Worker URL and auth token');
							return;
						}

						// Save configuration
						this.plugin.settings.workerUrl = workerUrl;
						await this.plugin.saveSettings();
						this.plugin.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, token);

						// Reinitialize plugin
						await this.plugin.initializeSync();

						new Notice('Configuration saved successfully!');
						this.display(); // Refresh the settings view
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

		new Setting(containerEl)
			.setName('Analytics Token')
			.setDesc('Optional. Create a read-only token with "Account Analytics Read" in the Cloudflare dashboard.')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setValue(this.plugin.secretStorage.get(SECRET_KEYS.ANALYTICS_TOKEN) || '')
					.onChange(value => this.plugin.secretStorage.set(SECRET_KEYS.ANALYTICS_TOKEN, value));
			});

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

	private renderUsageSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Usage' });

		const usageContainer = containerEl.createDiv({ cls: 'crate-usage-container' });

		new Setting(containerEl)
			.setName('Refresh Usage')
			.setDesc('Fetch the latest usage metrics from Cloudflare')
			.addButton(button => button
				.setButtonText('Refresh')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Loading...');
					try {
						await this.loadUsageData(usageContainer);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Refresh');
					}
				}));

		this.loadUsageData(usageContainer);
	}

	private async loadUsageData(container: HTMLElement): Promise<void> {
		container.empty();
		container.createEl('p', { text: 'Loading usage data...', cls: 'setting-item-description' });

		const data = await this.plugin.getUsage();
		container.empty();

		if (!data.available) {
			container.createEl('p', {
				text: data.error || 'Add an analytics token in the Connection section above to view usage metrics.',
				cls: 'setting-item-description',
			});
			return;
		}

		if (data.error) {
			container.createEl('p', {
				text: `Error: ${data.error}`,
				cls: 'setting-item-description',
			});
			return;
		}

		if (data.workers) {
			this.renderServiceUsage(container, 'Workers (Daily)', [
				{ label: 'Requests', metric: data.workers.requests },
			]);
		}

		if (data.r2) {
			this.renderServiceUsage(container, 'R2 Storage', [
				{ label: 'Storage', metric: data.r2.storageBytes },
				{ label: 'Class A Ops (Monthly)', metric: data.r2.classAOps },
				{ label: 'Class B Ops (Monthly)', metric: data.r2.classBOps },
			]);
		}

		if (data.d1) {
			this.renderServiceUsage(container, 'D1 Database (Daily)', [
				{ label: 'Rows Read', metric: data.d1.rowsRead },
				{ label: 'Rows Written', metric: data.d1.rowsWritten },
				{ label: 'Storage', metric: data.d1.storageBytes },
			]);
		}

		if (data.queriedAt) {
			container.createEl('p', {
				text: `Last updated: ${new Date(data.queriedAt).toLocaleString()}`,
				cls: 'setting-item-description',
			});
		}
	}

	private renderServiceUsage(
		container: HTMLElement,
		serviceName: string,
		metrics: Array<{ label: string; metric: UsageMetric }>
	): void {
		const section = container.createDiv({ cls: 'crate-usage-service' });
		section.createEl('h4', { text: serviceName });

		for (const { label, metric } of metrics) {
			const row = section.createDiv({ cls: 'crate-usage-row' });
			const pct = metric.limit > 0 ? (metric.current / metric.limit) * 100 : 0;

			const header = row.createDiv({ cls: 'crate-usage-header' });
			header.createSpan({ text: label, cls: 'crate-usage-label' });
			header.createSpan({
				text: this.formatMetric(metric),
				cls: 'crate-usage-value',
			});

			const bar = row.createDiv({ cls: 'crate-usage-bar' });
			const fill = bar.createDiv({ cls: 'crate-usage-bar-fill' });
			fill.style.width = `${Math.min(pct, 100)}%`;

			if (pct >= 90) {
				fill.addClass('crate-usage-bar-critical');
			} else if (pct >= 70) {
				fill.addClass('crate-usage-bar-warning');
			}
		}
	}

	private formatMetric(metric: UsageMetric): string {
		if (metric.unit === 'bytes') {
			return `${this.formatBytes(metric.current)} / ${this.formatBytes(metric.limit)}`;
		}
		return `${metric.current.toLocaleString()} / ${metric.limit.toLocaleString()}`;
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		const value = bytes / Math.pow(1024, i);
		return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
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

		// Force Full Sync
		const forceSyncSetting = new Setting(containerEl)
			.setName('Force Full Sync')
			.setDesc('Overwrite all remote files with local vault and remove remote-only files')
			.addButton(button => button
				.setButtonText('Force Full Update')
				.setWarning()
				.onClick(async () => {
					if (!confirm('This will overwrite ALL remote files with your local vault and delete remote-only files. This cannot be undone. Continue?')) {
						return;
					}

					button.setDisabled(true);
					button.setButtonText('Syncing...');
					forceProgressContainer.style.display = 'block';
					forceProgressFill.style.width = '0%';

					try {
						const result = await this.plugin.forceFullSync((current, total) => {
							button.setButtonText(`Syncing... ${current}/${total}`);
							const pct = Math.round((current / total) * 100);
							forceProgressFill.style.width = `${pct}%`;
							forceProgressLabel.textContent = `${current} / ${total} files`;
						});

						if (result.success) {
							new Notice(`Force sync complete: ${result.uploaded} uploaded, ${result.deleted} deleted`);
						} else {
							new Notice(`Force sync completed with errors`);
						}
					} catch (e) {
						new Notice('Force full sync failed');
					} finally {
						button.setDisabled(false);
						button.setButtonText('Force Full Update');
						forceProgressContainer.style.display = 'none';
						forceProgressFill.style.width = '0%';
						this.display();
					}
				}));

		const forceProgressContainer = forceSyncSetting.settingEl.createDiv({ cls: 'crate-sync-progress' });
		forceProgressContainer.style.display = 'none';
		const forceProgressLabel = forceProgressContainer.createDiv({ cls: 'crate-sync-progress-label' });
		const forceProgressBar = forceProgressContainer.createDiv({ cls: 'crate-sync-progress-bar' });
		const forceProgressFill = forceProgressBar.createDiv({ cls: 'crate-sync-progress-fill' });
	}
}
