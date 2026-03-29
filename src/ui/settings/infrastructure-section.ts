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
import { openConfirmationModal } from '../confirmation-modal';
import { createSettingsSectionHeading, createSettingsSubsectionHeading } from './section-helpers';

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
	isConfigured: boolean;
	rerender: () => void;
}

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin, isConfigured, rerender } = context;
	createSettingsSectionHeading(containerEl, 'Advanced');

	if (isConfigured) {
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
						const confirmed = await openConfirmationModal(plugin.app, {
							title: 'Upload all local files',
							message: 'Upload all local files in this vault to the sync server?',
							details: ['Use this for first-time setup on a new remote.'],
							confirmText: 'Upload all',
							warning: true,
						});
						if (!confirmed) {
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
						const confirmed = await openConfirmationModal(plugin.app, {
							title: 'Force full sync',
							message: 'Overwrite the remote vault with local files?',
							details: [
								'Remote-only files will be deleted.',
								'This action cannot be undone.',
							],
							confirmText: 'Force full update',
							warning: true,
						});
						if (!confirmed) {
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
	}

	renderInfrastructureManagementSection(context);
}

function inferWorkerNameFromUrl(workerUrl: string): string | null {
	const normalized = workerUrl.trim();
	if (!normalized) {
		return null;
	}

	try {
		const parsed = new URL(normalized);
		const hostname = parsed.hostname.toLowerCase();
		if (!hostname.endsWith('.workers.dev')) {
			return null;
		}
		const parts = hostname.split('.');
		if (parts.length < 3) {
			return null;
		}
		return parts[0] ?? null;
	} catch {
		return null;
	}
}

function renderInfrastructureManagementSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin, isConfigured, rerender } = context;

	createSettingsSubsectionHeading(containerEl, 'Infrastructure management');

	const diagnosticsContainer = containerEl.createDiv({ cls: 'crate-diagnostics' });
	diagnosticsContainer.hide();

	if (isConfigured) {
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
			.setName('Bucket')
			.setDesc(plugin.settings.bucketName || 'Not set');

		new Setting(containerEl)
			.setName('Database ID')
			.setDesc(plugin.settings.databaseId || 'Not set');
	}

	if (isConfigured && plugin.cloudflareSession.hasCredentials()) {
		const redeploySetting = new Setting(containerEl)
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
							new Notice('Please sign in first');
							return;
						}
						if (!plugin.settings.workerName) {
							new Notice('Worker name is missing in settings');
						return;
					}
					const credentials = resolved.credentials;
					const originalDesc = redeploySetting.descEl.textContent || '';

					await runButtonTask({
						button,
						idleText: 'Redeploy',
						runningText: 'Deploying...',
						progressEl: redeploySetting.descEl,
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
						onFinally: () => {
							redeploySetting.descEl.show();
							redeploySetting.descEl.textContent = originalDesc;
						},
					});
				}));
	}

	if (isConfigured) {
		const diagnosticsSetting = new Setting(containerEl)
			.setName('Run diagnostics')
			.setDesc('Check worker connectivity and resource visibility')
			.addButton(button => button
				.setButtonText('Run')
				.onClick(async () => {
					const resolved = await resolveCloudflareCredentials(plugin);
					if (resolved.hadError) {
						return;
					}
					const originalDesc = diagnosticsSetting.descEl.textContent || '';

					await runButtonTask({
						button,
						idleText: 'Run',
						runningText: 'Running...',
						progressEl: diagnosticsSetting.descEl,
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
						onFinally: () => {
							diagnosticsSetting.descEl.show();
							diagnosticsSetting.descEl.textContent = originalDesc;
						},
					});
				}));
	}

	if (plugin.cloudflareSession.hasCredentials()) {
		const deleteSetting = new Setting(containerEl)
			.setName('Delete infrastructure')
			.setDesc('Delete the worker, stored bucket objects, and database. This removes all synced data.')
			.addButton(button => button
				.setButtonText('Delete infrastructure')
				.setWarning()
				.onClick(async () => {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Delete infrastructure',
						message: 'Permanently delete the sync infrastructure and all synced data?',
						details: [
							'This removes the worker, bucket objects, and database.',
							'This action cannot be undone.',
						],
						confirmText: 'Delete infrastructure',
						warning: true,
					});
					if (!confirmed) {
						return;
					}

					const resolved = await resolveCloudflareCredentials(plugin);
						if (resolved.hadError) {
							return;
						}
						if (!resolved.credentials) {
							new Notice('Please sign in first');
							return;
						}
					const credentials = resolved.credentials;

					const shouldSuspendSync = plugin.syncRuntime.isConfigured();
					let shouldResumeSync = false;
					const originalDesc = deleteSetting.descEl.textContent || '';

					await runButtonTask({
						button,
						idleText: 'Delete infrastructure',
						runningText: 'Resetting...',
						progressEl: deleteSetting.descEl,
						progressMessage: 'Deleting resources...',
						onStart: async () => {
							// Ensure no worker sync requests are triggered while reset is running.
							if (shouldSuspendSync) {
								plugin.syncRuntime.destroy();
								shouldResumeSync = true;
							}
						},
						task: async ({ setProgress }) => resetInfrastructure(
							{
								accountId: credentials.accountId,
								apiToken: credentials.apiToken,
								workerName: plugin.settings.workerName || inferWorkerNameFromUrl(plugin.settings.workerUrl) || undefined,
								bucketName: plugin.settings.bucketName || undefined,
								databaseId: plugin.settings.databaseId || undefined,
								includeCratePrefixed: true,
							},
							setProgress
						),
						onSuccess: async (result) => {
							if (result.failed.length === 0) {
								if (result.deleted.length === 0) {
									new Notice('No remote resources were found to delete. Local configuration was kept.');
									return;
								}
								shouldResumeSync = false;
								await plugin.syncRuntime.clearSyncConfiguration();
								new Notice(`Infrastructure reset complete (${result.deleted.length} deleted)`);
								rerender();
								return;
							}

								new Notice(`Reset finished with errors (${result.failed.length} failed)`);
								diagnosticsContainer.show();
								diagnosticsContainer.empty();
								createSettingsSubsectionHeading(diagnosticsContainer, 'Reset errors');
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
						onFinally: async () => {
							deleteSetting.descEl.show();
							deleteSetting.descEl.textContent = originalDesc;

							if (!shouldResumeSync || !plugin.syncRuntime.isConfigured()) {
								return;
							}

							const previousSyncOnStartup = plugin.settings.syncOnStartup;
							plugin.settings.syncOnStartup = false;
							try {
								await plugin.syncRuntime.initialize();
							} catch (error) {
								new Notice(`Reset finished, but sync could not be resumed: ${getErrorMessage(error)}`);
							} finally {
								plugin.settings.syncOnStartup = previousSyncOnStartup;
							}
						},
					});
				}));
	}
}

function renderDiagnostics(containerEl: HTMLElement, results: DiagnosticResult[]): void {
	containerEl.show();
	containerEl.empty();
	createSettingsSubsectionHeading(containerEl, 'Diagnostics');

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
