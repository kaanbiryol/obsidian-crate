import { Notice, Setting } from 'obsidian';
import {
	redeployFromPlugin,
	resetInfrastructure,
	runDiagnostics,
	type DiagnosticResult,
} from '../../cloudflare/infrastructure';
import type CratePlugin from '../../main';
import { SECRET_KEYS } from '../../types';
import {
	createFileSyncProgress,
	getErrorMessage,
	hideFileSyncProgress,
	runButtonTask,
	showFileSyncProgress,
	updateFileSyncProgress,
} from './action-helpers';

interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

interface ResolveCredentialResult {
	credentials: CloudflareCredentials | null;
	hadError: boolean;
}

export interface InfrastructureSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin, rerender } = context;
	containerEl.createEl('h3', { text: 'Advanced' });

	new Setting(containerEl)
		.setName('Test connection')
		.setDesc('Verify that the plugin can connect to your sync server')
		.addButton(button => button
			.setButtonText('Test')
			.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Test',
					runningText: 'Testing...',
					task: async () => plugin.syncRuntime.testConnection(),
					onSuccess: (result) => {
						if (result.success) {
							new Notice('Connection successful');
						} else {
							new Notice(`Connection failed: ${result.error}`);
						}
					},
					onError: () => {
						new Notice('Connection test failed');
					},
				});
			}));

	new Setting(containerEl)
		.setName('Device ID')
		.setDesc('Unique identifier for this device')
		.addText(text => text
			.setValue(plugin.settings.deviceId)
			.onChange(async (value) => {
				plugin.settings.deviceId = value;
				await plugin.saveSettings();
			}));

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

				await runButtonTask({
					button,
					idleText: 'Upload all',
					runningText: 'Uploading...',
					onStart: () => {
						showFileSyncProgress(initialProgress);
					},
					task: async ({ setButtonText }) => plugin.syncRuntime.initialSync((current, total) => {
						setButtonText(`Uploading... ${current}/${total}`);
						updateFileSyncProgress(initialProgress, current, total);
					}),
					onSuccess: (result) => {
						if (result.success) {
							new Notice(`Initial sync complete: ${result.uploaded} files uploaded`);
						} else {
							new Notice('Initial sync completed with errors');
						}
					},
					onError: () => {
						new Notice('Initial sync failed');
					},
					onFinally: () => {
						hideFileSyncProgress(initialProgress);
						rerender();
					},
				});
			}));
	const initialProgress = createFileSyncProgress(initialSyncSetting);

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

				await runButtonTask({
					button,
					idleText: 'Force full update',
					runningText: 'Syncing...',
					onStart: () => {
						showFileSyncProgress(forceProgress);
					},
					task: async ({ setButtonText }) => plugin.syncRuntime.forceFullSync((current, total) => {
						setButtonText(`Syncing... ${current}/${total}`);
						updateFileSyncProgress(forceProgress, current, total);
					}),
					onSuccess: (result) => {
						if (result.success) {
							new Notice(`Force sync complete: ${result.uploaded} uploaded, ${result.deleted} deleted`);
						} else {
							new Notice('Force sync completed with errors');
						}
					},
					onError: () => {
						new Notice('Force full sync failed');
					},
					onFinally: () => {
						hideFileSyncProgress(forceProgress);
						rerender();
					},
				});
			}));
	const forceProgress = createFileSyncProgress(forceSyncSetting);

	if (plugin.syncRuntime.isConfigured()) {
		renderInfrastructureManagementSection(context);
	}
}

function renderInfrastructureManagementSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin, rerender } = context;

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
			.setValue(plugin.settings.workerUrl)
			.setDisabled(true));

	new Setting(containerEl)
		.setName('Worker name')
		.setDesc(plugin.settings.workerName || 'Not set');

	new Setting(containerEl)
		.setName('R2 bucket')
		.setDesc(plugin.settings.bucketName || 'Not set');

	new Setting(containerEl)
		.setName('D1 database ID')
		.setDesc(plugin.settings.databaseId || 'Not set');

	new Setting(containerEl)
		.setName('Redeploy worker code')
		.setDesc('Equivalent to CLI deploy/update using stored worker name')
		.addButton(button => button
			.setButtonText('Redeploy')
			.onClick(async () => {
				const resolved = await resolveCloudflareCredentials(plugin);
				if (resolved.hadError) {
					return;
				}
				if (!resolved.credentials) {
					new Notice('Please sign in with Cloudflare first');
					return;
				}
				if (!plugin.settings.workerName) {
					new Notice('Worker name is missing in settings');
					return;
				}
				const credentials = resolved.credentials;

				await runButtonTask({
					button,
					idleText: 'Redeploy',
					runningText: 'Deploying...',
					progressEl: managementProgress,
					progressMessage: 'Redeploying worker...',
					task: async ({ setProgress }) => redeployFromPlugin(
						{
							accountId: credentials.accountId,
							apiToken: credentials.apiToken,
							workerName: plugin.settings.workerName,
						},
						setProgress
					),
					onSuccess: () => {
						new Notice('Worker redeployed successfully');
					},
					onError: (error) => {
						new Notice(`Redeploy failed: ${getErrorMessage(error)}`);
					},
				});
			}));

	new Setting(containerEl)
		.setName('Run diagnostics')
		.setDesc('Check worker connectivity and Cloudflare resource visibility')
		.addButton(button => button
			.setButtonText('Run')
			.onClick(async () => {
				const resolved = await resolveCloudflareCredentials(plugin);
				if (resolved.hadError) {
					return;
				}

				await runButtonTask({
					button,
					idleText: 'Run',
					runningText: 'Running...',
					progressEl: managementProgress,
					progressMessage: 'Running diagnostics...',
					task: async () => runDiagnostics({
						workerUrl: plugin.settings.workerUrl,
						authToken: plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || undefined,
						accountId: resolved.credentials?.accountId,
						apiToken: resolved.credentials?.apiToken,
						workerName: plugin.settings.workerName || undefined,
						bucketName: plugin.settings.bucketName || undefined,
						databaseId: plugin.settings.databaseId || undefined,
					}),
					onSuccess: (results) => {
						renderDiagnostics(diagnosticsContainer, results);

						const failures = results.filter(r => r.status === 'fail').length;
						const warnings = results.filter(r => r.status === 'warn').length;
						if (failures === 0 && warnings === 0) {
							new Notice('Diagnostics passed');
						} else {
							new Notice(`Diagnostics complete: ${failures} fail, ${warnings} warn`);
						}
					},
					onError: (error) => {
						new Notice(`Diagnostics failed: ${getErrorMessage(error)}`);
					},
				});
			}));

	new Setting(containerEl)
		.setName('Delete infrastructure')
		.setDesc('Deletes worker, R2 bucket objects, and D1 database. This removes all synced data.')
		.addButton(button => button
			.setButtonText('Delete infrastructure')
			.setWarning()
			.onClick(async () => {
				const resolved = await resolveCloudflareCredentials(plugin);
				if (resolved.hadError) {
					return;
				}
				if (!resolved.credentials) {
					new Notice('Please sign in with Cloudflare first');
					return;
				}
				const credentials = resolved.credentials;

				const confirmed = confirm(
					'This will permanently delete infrastructure and all synced data (R2, Worker, D1). This cannot be undone. Continue?'
				);
				if (!confirmed) {
					return;
				}

				await runButtonTask({
					button,
					idleText: 'Delete infrastructure',
					runningText: 'Resetting...',
					progressEl: managementProgress,
					progressMessage: 'Deleting resources...',
					task: async ({ setProgress }) => resetInfrastructure(
						{
							accountId: credentials.accountId,
							apiToken: credentials.apiToken,
							workerName: plugin.settings.workerName || undefined,
							bucketName: plugin.settings.bucketName || undefined,
							databaseId: plugin.settings.databaseId || undefined,
							includeCratePrefixed: true,
						},
						setProgress
					),
					onSuccess: async (result) => {
						if (result.failed.length === 0) {
							await plugin.syncRuntime.clearSyncConfiguration();
							new Notice(`Infrastructure reset complete (${result.deleted.length} deleted)`);
							rerender();
							return;
						}

						new Notice(`Reset finished with errors (${result.failed.length} failed)`);
						diagnosticsContainer.style.display = 'block';
						diagnosticsContainer.addClass('crate-diagnostics');
						diagnosticsContainer.empty();
						diagnosticsContainer.createEl('h4', { text: 'Reset errors' });
						for (const message of result.failed) {
							diagnosticsContainer.createEl('p', {
								text: `- ${message}`,
								cls: 'setting-item-description',
							});
						}
					},
					onError: (error) => {
						new Notice(`Reset failed: ${getErrorMessage(error)}`);
					},
				});
			}));
}

function renderDiagnostics(containerEl: HTMLElement, results: DiagnosticResult[]): void {
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

async function resolveCloudflareCredentials(plugin: CratePlugin): Promise<ResolveCredentialResult> {
	try {
		const credentials = await plugin.cloudflareSession.resolveCredentials();
		return { credentials, hadError: false };
	} catch (error) {
		new Notice(`Cloudflare session refresh failed: ${getErrorMessage(error)}`);
		return { credentials: null, hadError: true };
	}
}
