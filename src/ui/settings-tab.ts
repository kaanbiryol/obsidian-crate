/**
 * Settings tab for Obsidian Crate configuration
 */

import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import {
	quickSetup,
	redeployFromPlugin,
	resetInfrastructure,
	runDiagnostics,
	type DiagnosticResult,
} from '../cloudflare/infrastructure';
import { verifyCredentials } from '../cloudflare/api';
import type CratePlugin from '../main';
import { SECRET_KEYS, type UsageMetric } from '../types';

export class CrateSettingTab extends PluginSettingTab {
	plugin: CratePlugin;
	private manualEntryEnabled = false;
	private manualAccountId = '';
	private manualApiToken = '';
	private manualBucketName = '';
	private manualWorkerName = '';

	constructor(app: App, plugin: CratePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('crate-settings');

		containerEl.createEl('h2', { text: 'Obsidian Crate settings' });

		this.renderConfigSection(containerEl);

		if (this.plugin.syncRuntime.isConfigured()) {
			this.renderConnectionSection(containerEl);
			this.renderUsageSection(containerEl);
			this.renderSyncSection(containerEl);
			this.renderAdvancedSection(containerEl);
		}
	}

	private renderConfigSection(containerEl: HTMLElement): void {
		if (!this.manualAccountId) {
			this.manualAccountId = this.plugin.settings.cloudflareAccountId.trim();
		}
		if (!this.manualApiToken) {
			this.manualApiToken = (this.plugin.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
		}
		if (!this.manualBucketName) {
			this.manualBucketName = this.plugin.settings.bucketName.trim();
		}
		if (!this.manualWorkerName) {
			this.manualWorkerName = this.plugin.settings.workerName.trim();
		}

		const hasCloudflareCredentials = this.plugin.cloudflareSession.hasCredentials();
		if (hasCloudflareCredentials) {
			this.manualEntryEnabled = false;
		}

		containerEl.createEl('h3', { text: 'Configuration' });
		containerEl.createEl('p', {
			text: 'Sign in with Cloudflare to enable one-click setup and infrastructure management.',
			cls: 'setting-item-description',
		});

		const setupProgress = containerEl.createEl('p', {
			cls: 'setting-item-description crate-action-progress',
		});
		setupProgress.style.display = 'none';

		if (!hasCloudflareCredentials) {
			const quickGuide = containerEl.createDiv({ cls: 'crate-quick-guide' });
			quickGuide.createEl('h4', { text: 'Quick setup guide' });
			const quickGuideList = quickGuide.createEl('ol');
			quickGuideList.createEl('li', {
				text: 'Select Sign in with Cloudflare and approve access in your browser.',
			});
			quickGuideList.createEl('li', {
				text: 'Infrastructure setup runs automatically right after sign-in.',
			});
			quickGuideList.createEl('li', {
				text: 'If setup fails, use Create infrastructure. Then run Test connection and Sync now.',
			});

			new Setting(containerEl)
				.setName('Cloudflare sign in')
				.setDesc('Authorize directly in browser and auto-create infrastructure (desktop)')
				.addButton(button => button
					.setButtonText('Sign in with Cloudflare')
					.setCta()
					.onClick(async () => {
						let loggedIn = false;
						button.setDisabled(true);
						button.setButtonText('Waiting...');
						setupProgress.style.display = 'block';
						setupProgress.textContent = 'Waiting for Cloudflare authorization...';
						try {
							await this.plugin.cloudflareSession.loginWithCloudflare();
							loggedIn = true;
							const creds = await this.plugin.cloudflareSession.resolveCredentials();
							if (!creds) {
								throw new Error('Cloudflare credentials are unavailable after login');
							}

							setupProgress.textContent = 'Creating infrastructure...';
							await this.createInfrastructureFromCredentials(creds, setupProgress);

							new Notice('Cloudflare login successful and infrastructure is ready');
							this.display();
						} catch (error) {
							const message = error instanceof Error ? error.message : 'Unknown error';
							if (loggedIn) {
								new Notice(`Cloudflare login succeeded but setup failed: ${message}`);
							} else {
								new Notice(`Cloudflare login failed: ${message}`);
							}
						} finally {
							button.setDisabled(false);
							button.setButtonText('Sign in with Cloudflare');
							setupProgress.style.display = 'none';
						}
						}));
		} else {
			new Setting(containerEl)
				.setName('Cloudflare account')
				.setDesc(this.plugin.settings.cloudflareAccountId)
				.addButton(button => button
					.setButtonText('Re-authenticate')
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText('Waiting...');
						try {
							await this.plugin.cloudflareSession.loginWithCloudflare();
							if (!this.plugin.syncRuntime.isConfigured()) {
								setupProgress.style.display = 'block';
								setupProgress.textContent = 'Creating infrastructure...';
								const creds = await this.plugin.cloudflareSession.resolveCredentials();
								if (!creds) {
									throw new Error('Cloudflare credentials are unavailable after login');
								}
								await this.createInfrastructureFromCredentials(creds, setupProgress);
								new Notice('Cloudflare account updated and infrastructure is ready');
							} else {
								new Notice('Cloudflare account updated');
							}
							this.display();
						} catch (error) {
							new Notice(`Cloudflare login failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
						} finally {
							button.setDisabled(false);
							button.setButtonText('Re-authenticate');
							setupProgress.style.display = 'none';
						}
					}))
				.addExtraButton(button => button
					.setIcon('x')
					.setTooltip('Sign out from Cloudflare')
					.onClick(async () => {
						await this.plugin.cloudflareSession.clearCredentials();
						new Notice('Cloudflare credentials cleared');
						this.display();
					}));
		}

		if (!hasCloudflareCredentials) {
			new Setting(containerEl)
				.setName('Manual entry')
				.setDesc('Show advanced fields for account, API token, bucket, and worker names')
				.addToggle(toggle => toggle
					.setValue(this.manualEntryEnabled)
					.onChange((value) => {
						this.manualEntryEnabled = value;
						this.display();
					}));

			if (this.manualEntryEnabled) {
				new Setting(containerEl)
					.setName('Cloudflare account ID')
					.setDesc('Used for manual setup mode')
					.addText(text => {
						text
							.setPlaceholder('Cloudflare account ID')
							.setValue(this.manualAccountId)
							.onChange(value => {
								this.manualAccountId = value.trim();
							});
						text.inputEl.size = 50;
					});

				new Setting(containerEl)
					.setName('Cloudflare API token')
					.setDesc('Used for manual setup mode')
					.addText(text => {
						text.inputEl.type = 'password';
						text
							.setPlaceholder('Paste Cloudflare API token')
							.setValue(this.manualApiToken)
							.onChange(value => {
								this.manualApiToken = value.trim();
							});
						text.inputEl.size = 50;
					});

				new Setting(containerEl)
					.setName('R2 bucket name')
					.setDesc('Optional for setup. Leave empty to auto-generate')
					.addText(text => {
						text
							.setPlaceholder('crate-xxxxxxxx')
							.setValue(this.manualBucketName)
							.onChange(value => {
								this.manualBucketName = value.trim();
							});
						text.inputEl.size = 40;
					});

				new Setting(containerEl)
					.setName('Worker name')
					.setDesc('Optional for setup. Leave empty to auto-generate')
					.addText(text => {
						text
							.setPlaceholder('crate-sync-xxxxxx')
							.setValue(this.manualWorkerName)
							.onChange(value => {
								this.manualWorkerName = value.trim();
							});
						text.inputEl.size = 40;
					});

				new Setting(containerEl)
					.setName('Save manual credentials')
					.setDesc('Validate and save account ID and API token from manual entry fields')
					.addButton(button => button
						.setButtonText('Save')
						.onClick(async () => {
							button.setDisabled(true);
							button.setButtonText('Validating...');
							try {
								const accountId = this.manualAccountId.trim();
								const apiToken = this.manualApiToken.trim();
								if (!accountId || !apiToken) {
									new Notice('Enter both Cloudflare account ID and API token');
									return;
								}

								const valid = await verifyCredentials({ accountId, apiToken });
								if (!valid) {
									new Notice('Cloudflare credentials are invalid');
									return;
								}
								await this.plugin.cloudflareSession.saveCredentials(accountId, apiToken);
								new Notice('Manual Cloudflare credentials saved');
								this.display();
							} catch (error) {
								new Notice(`Failed to save manual credentials: ${error instanceof Error ? error.message : 'Unknown error'}`);
							} finally {
								button.setDisabled(false);
								button.setButtonText('Save');
							}
						}));
			}
		}

		if (!this.plugin.syncRuntime.isConfigured() && (hasCloudflareCredentials || this.manualEntryEnabled)) {
			new Setting(containerEl)
				.setName('Quick setup')
				.setDesc('Create R2 + D1 + Worker and configure this plugin automatically')
				.addButton(button => button
					.setButtonText('Create infrastructure')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText('Working...');
						setupProgress.style.display = 'block';
						setupProgress.textContent = 'Starting setup...';

						try {
							const creds = await this.resolveCredentialsForSetup();
							await this.createInfrastructureFromCredentials(creds, setupProgress);
							new Notice('Infrastructure created and plugin configured');
							this.display();
						} catch (error) {
							new Notice(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
						} finally {
							button.setDisabled(false);
							button.setButtonText('Create infrastructure');
							setupProgress.style.display = 'none';
						}
					}));
		}

		if (hasCloudflareCredentials) {
			new Setting(containerEl)
				.setName('Reset local plugin configuration')
				.setDesc('Clears worker URL/auth token and local infrastructure metadata')
				.addButton(button => button
					.setButtonText('Reset local')
					.setWarning()
					.onClick(async () => {
						if (!confirm('Clear local plugin configuration? Cloudflare resources will not be deleted.')) {
							return;
						}
						await this.plugin.syncRuntime.clearSyncConfiguration();
						new Notice('Local plugin configuration cleared');
						this.display();
					}));
		}
	}

	private async resolveCredentialsForSetup(): Promise<{ accountId: string; apiToken: string }> {
		if (this.manualEntryEnabled) {
			const accountId = this.manualAccountId.trim();
			const apiToken = this.manualApiToken.trim();
			if (!accountId || !apiToken) {
				throw new Error('Enter both Cloudflare account ID and API token in manual entry mode');
			}

			const valid = await verifyCredentials({ accountId, apiToken });
			if (!valid) {
				throw new Error('Cloudflare credentials are invalid');
			}

			await this.plugin.cloudflareSession.saveCredentials(accountId, apiToken);
			return { accountId, apiToken };
		}

		const creds = await this.plugin.cloudflareSession.resolveCredentials();
		if (!creds) {
			throw new Error('Please sign in with Cloudflare first');
		}

		return creds;
	}

	private async createInfrastructureFromCredentials(
		creds: { accountId: string; apiToken: string },
		progressEl: HTMLElement
	): Promise<void> {
		const result = await quickSetup(
			{
				accountId: creds.accountId,
				apiToken: creds.apiToken,
				bucketName: this.manualEntryEnabled && this.manualBucketName
					? this.manualBucketName
					: undefined,
				workerName: this.manualEntryEnabled && this.manualWorkerName
					? this.manualWorkerName
					: undefined,
			},
			(message) => {
				progressEl.textContent = message;
			}
		);

		await this.plugin.syncRuntime.applyInfrastructureConfig({
			workerUrl: result.workerUrl,
			authToken: result.authToken,
			workerName: result.workerName,
			bucketName: result.bucketName,
			databaseId: result.databaseId,
			accountId: creds.accountId,
		});
	}

	private renderDiagnostics(containerEl: HTMLElement, results: DiagnosticResult[]): void {
		containerEl.style.display = 'block';
		containerEl.addClass('crate-diagnostics');
		containerEl.empty();
		containerEl.createEl('h4', { text: 'Diagnostics' });

		for (const result of results) {
			const row = containerEl.createDiv({ cls: 'crate-diagnostic-row' });
			const prefix = result.status === 'pass' ? 'PASS' : result.status === 'warn' ? 'WARN' : 'FAIL';
			row.createEl('p', {
				text: `${prefix} ${result.name}: ${result.message}`,
				cls: `setting-item-description crate-diagnostic-${result.status}`,
			});
		}
	}

	private renderInfrastructureManagementSection(containerEl: HTMLElement): void {
		containerEl.createEl('h4', { text: 'Infrastructure management' });

		const managementProgress = containerEl.createEl('p', {
			cls: 'setting-item-description crate-action-progress',
		});
		managementProgress.style.display = 'none';

		const diagnosticsContainer = containerEl.createDiv();
		diagnosticsContainer.style.display = 'none';

		new Setting(containerEl)
			.setName('Worker URL')
			.setDesc('Current sync endpoint')
			.addText(text => text
				.setValue(this.plugin.settings.workerUrl)
				.setDisabled(true));

		new Setting(containerEl)
			.setName('Worker name')
			.setDesc(this.plugin.settings.workerName || 'Not set');

		new Setting(containerEl)
			.setName('R2 bucket')
			.setDesc(this.plugin.settings.bucketName || 'Not set');

		new Setting(containerEl)
			.setName('D1 database ID')
			.setDesc(this.plugin.settings.databaseId || 'Not set');

		new Setting(containerEl)
			.setName('Redeploy worker code')
			.setDesc('Equivalent to CLI deploy/update using stored worker name')
			.addButton(button => button
				.setButtonText('Redeploy')
				.onClick(async () => {
					let creds: { accountId: string; apiToken: string } | null = null;
					try {
						creds = await this.plugin.cloudflareSession.resolveCredentials();
					} catch (error) {
						new Notice(`Cloudflare session refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
						return;
					}
					if (!creds) {
						new Notice('Please sign in with Cloudflare first');
						return;
					}
					if (!this.plugin.settings.workerName) {
						new Notice('Worker name is missing in settings');
						return;
					}

					button.setDisabled(true);
					button.setButtonText('Deploying...');
					managementProgress.style.display = 'block';
					managementProgress.textContent = 'Redeploying worker...';

					try {
						await redeployFromPlugin(
							{
								accountId: creds.accountId,
								apiToken: creds.apiToken,
								workerName: this.plugin.settings.workerName,
							},
							(message) => {
								managementProgress.textContent = message;
							}
						);
						new Notice('Worker redeployed successfully');
					} catch (error) {
						new Notice(`Redeploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Redeploy');
						managementProgress.style.display = 'none';
					}
				}));

		new Setting(containerEl)
			.setName('Run diagnostics')
			.setDesc('Check worker connectivity and Cloudflare resource visibility')
			.addButton(button => button
				.setButtonText('Run')
				.onClick(async () => {
					let creds: { accountId: string; apiToken: string } | null = null;
					try {
						creds = await this.plugin.cloudflareSession.resolveCredentials();
					} catch (error) {
						new Notice(`Cloudflare session refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
						return;
					}
					button.setDisabled(true);
					button.setButtonText('Running...');
					managementProgress.style.display = 'block';
					managementProgress.textContent = 'Running diagnostics...';

					try {
						const results = await runDiagnostics({
							workerUrl: this.plugin.settings.workerUrl,
							authToken: this.plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || undefined,
							accountId: creds?.accountId,
							apiToken: creds?.apiToken,
							workerName: this.plugin.settings.workerName || undefined,
							bucketName: this.plugin.settings.bucketName || undefined,
							databaseId: this.plugin.settings.databaseId || undefined,
						});
						this.renderDiagnostics(diagnosticsContainer, results);

						const failures = results.filter(r => r.status === 'fail').length;
						const warnings = results.filter(r => r.status === 'warn').length;
						if (failures === 0 && warnings === 0) {
							new Notice('Diagnostics passed');
						} else {
							new Notice(`Diagnostics complete: ${failures} fail, ${warnings} warn`);
						}
					} catch (error) {
						new Notice(`Diagnostics failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Run');
						managementProgress.style.display = 'none';
					}
				}));

		new Setting(containerEl)
			.setName('Delete infrastructure')
			.setDesc('Deletes worker, R2 bucket objects, and D1 database. This removes all synced data.')
			.addButton(button => button
				.setButtonText('Delete infrastructure')
				.setWarning()
				.onClick(async () => {
					let creds: { accountId: string; apiToken: string } | null = null;
					try {
						creds = await this.plugin.cloudflareSession.resolveCredentials();
					} catch (error) {
						new Notice(`Cloudflare session refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
						return;
					}
					if (!creds) {
						new Notice('Please sign in with Cloudflare first');
						return;
					}

					const confirmed = confirm(
						'This will permanently delete infrastructure and all synced data (R2, Worker, D1). This cannot be undone. Continue?'
					);
					if (!confirmed) {
						return;
					}

					button.setDisabled(true);
					button.setButtonText('Resetting...');
					managementProgress.style.display = 'block';
					managementProgress.textContent = 'Deleting resources...';

					try {
						const result = await resetInfrastructure(
							{
								accountId: creds.accountId,
								apiToken: creds.apiToken,
								workerName: this.plugin.settings.workerName || undefined,
								bucketName: this.plugin.settings.bucketName || undefined,
								databaseId: this.plugin.settings.databaseId || undefined,
								includeCratePrefixed: true,
							},
							(message) => {
								managementProgress.textContent = message;
							}
						);

						if (result.failed.length === 0) {
							await this.plugin.syncRuntime.clearSyncConfiguration();
							new Notice(`Infrastructure reset complete (${result.deleted.length} deleted)`);
							this.display();
						} else {
							new Notice(`Reset finished with errors (${result.failed.length} failed)`);
							diagnosticsContainer.style.display = 'block';
							diagnosticsContainer.addClass('crate-diagnostics');
							diagnosticsContainer.empty();
							diagnosticsContainer.createEl('h4', { text: 'Reset errors' });
							for (const message of result.failed) {
								diagnosticsContainer.createEl('p', { text: `- ${message}`, cls: 'setting-item-description' });
							}
						}
					} catch (error) {
						new Notice(`Reset failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Delete infrastructure');
						managementProgress.style.display = 'none';
					}
				}));
	}

	private renderConnectionSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Connection' });

		const lastSync = this.plugin.settings.lastSync;
		new Setting(containerEl)
			.setName('Last sync')
			.setDesc(lastSync ? new Date(lastSync).toLocaleString() : 'Never');
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Sync' });

		new Setting(containerEl)
			.setName('Sync now')
			.setDesc('Manually trigger a full sync')
			.addButton(button => button
				.setButtonText('Sync now')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Syncing...');

					try {
						const result = await this.plugin.syncRuntime.sync();
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
						button.setButtonText('Sync now');
						this.display();
					}
				}));

		new Setting(containerEl)
			.setName('Sync on startup')
			.setDesc('Automatically sync when Obsidian starts')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync interval')
			.setDesc('How often to check for remote changes (seconds, 0 disables)')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncInterval))
				.onChange(async (value) => {
					const interval = parseInt(value, 10);
					if (!isNaN(interval) && interval >= 0) {
						this.plugin.settings.syncInterval = interval;
						await this.plugin.saveSettings();
						this.plugin.syncRuntime.updateSyncSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Show status bar')
			.setDesc('Display sync status in the status bar')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStatusBar)
				.onChange(async (value) => {
					this.plugin.settings.showStatusBar = value;
					await this.plugin.saveSettings();
					this.plugin.syncRuntime.updateStatusBar(value);
				}));
	}

	private renderUsageSection(containerEl: HTMLElement): void {
		containerEl.createEl('h3', { text: 'Usage' });

		const usageHelp = containerEl.createDiv({ cls: 'setting-item-description' });
		usageHelp.appendText('To enable usage metrics, create a Cloudflare API token with ');
		usageHelp.createEl('strong', { text: 'Account > Account Analytics > Read' });
		usageHelp.appendText(' permission and paste it below. ');
		const tokenLink = usageHelp.createEl('a', {
			text: 'Create token in Cloudflare dashboard',
			href: 'https://dash.cloudflare.com/profile/api-tokens',
		});
		tokenLink.target = '_blank';
		tokenLink.rel = 'noopener noreferrer';

		new Setting(containerEl)
			.setName('Analytics token')
			.setDesc('Optional. Create a read-only token with Account Analytics Read in Cloudflare')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setValue(this.plugin.secretStorage.get(SECRET_KEYS.ANALYTICS_TOKEN) || '')
					.onChange(value => this.plugin.secretStorage.set(SECRET_KEYS.ANALYTICS_TOKEN, value));
			});

		const usageContainer = containerEl.createDiv({ cls: 'crate-usage-container' });

		new Setting(containerEl)
			.setName('Refresh usage')
			.setDesc('Fetch latest usage metrics from Cloudflare')
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

		void this.loadUsageData(usageContainer);
	}

	private async loadUsageData(container: HTMLElement): Promise<void> {
		container.empty();
		container.createEl('p', { text: 'Loading usage data...', cls: 'setting-item-description' });

		const data = await this.plugin.usageService.getUsage(
			this.plugin.secretStorage.get(SECRET_KEYS.ANALYTICS_TOKEN),
			this.plugin.syncRuntime.getApiClient()
		);
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
			this.renderServiceUsage(container, 'Workers (daily)', [
				{ label: 'Requests', metric: data.workers.requests },
			]);
		}

		if (data.r2) {
			this.renderServiceUsage(container, 'R2 storage', [
				{ label: 'Storage', metric: data.r2.storageBytes },
				{ label: 'Class A ops (monthly)', metric: data.r2.classAOps },
				{ label: 'Class B ops (monthly)', metric: data.r2.classBOps },
			]);
		}

		if (data.d1) {
			this.renderServiceUsage(container, 'D1 database (daily)', [
				{ label: 'Rows read', metric: data.d1.rowsRead },
				{ label: 'Rows written', metric: data.d1.rowsWritten },
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
			.setName('Test connection')
			.setDesc('Verify that the plugin can connect to your sync server')
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing...');

					try {
						const result = await this.plugin.syncRuntime.testConnection();
						if (result.success) {
							new Notice('Connection successful');
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
			.setName('Device ID')
			.setDesc('Unique identifier for this device')
			.addText(text => text
				.setValue(this.plugin.settings.deviceId)
				.onChange(async (value) => {
					this.plugin.settings.deviceId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Ignore patterns')
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
						this.plugin.syncRuntime.updateSyncSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.cols = 40;
			});

		const initialSyncSetting = new Setting(containerEl)
			.setName('Initial sync')
			.setDesc('Upload all local files to the server (use for first-time setup)')
			.addButton(button => button
				.setButtonText('Upload all')
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
						const result = await this.plugin.syncRuntime.initialSync((current, total) => {
							button.setButtonText(`Uploading... ${current}/${total}`);
							const pct = Math.round((current / total) * 100);
							progressFill.style.width = `${pct}%`;
							progressLabel.textContent = `${current} / ${total} files`;
						});

						if (result.success) {
							new Notice(`Initial sync complete: ${result.uploaded} files uploaded`);
						} else {
							new Notice('Initial sync completed with errors');
						}
					} catch (e) {
						new Notice('Initial sync failed');
					} finally {
						button.setDisabled(false);
						button.setButtonText('Upload all');
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

		const forceSyncSetting = new Setting(containerEl)
			.setName('Force full sync')
			.setDesc('Overwrite all remote files with local vault and remove remote-only files')
			.addButton(button => button
				.setButtonText('Force full update')
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
						const result = await this.plugin.syncRuntime.forceFullSync((current, total) => {
							button.setButtonText(`Syncing... ${current}/${total}`);
							const pct = Math.round((current / total) * 100);
							forceProgressFill.style.width = `${pct}%`;
							forceProgressLabel.textContent = `${current} / ${total} files`;
						});

						if (result.success) {
							new Notice(`Force sync complete: ${result.uploaded} uploaded, ${result.deleted} deleted`);
						} else {
							new Notice('Force sync completed with errors');
						}
					} catch (e) {
						new Notice('Force full sync failed');
					} finally {
						button.setDisabled(false);
						button.setButtonText('Force full update');
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

		if (this.plugin.syncRuntime.isConfigured()) {
			this.renderInfrastructureManagementSection(containerEl);
		}
	}
}
