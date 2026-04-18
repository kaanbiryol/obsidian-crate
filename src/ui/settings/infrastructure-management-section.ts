import { Notice, Setting } from 'obsidian';
import {
	redeployFromPlugin,
	resetInfrastructure,
	runDiagnostics,
} from '../../cloudflare/infrastructure';
import { SECRET_KEYS } from '../../plugin/types';
import { openConfirmationModal } from '../confirmation-modal';
import { getErrorMessage, runButtonTask } from './action-helpers';
import { resolveCloudflareCredentials } from './infrastructure-credentials';
import {
	getDiagnosticsNoticeMessage,
	inferWorkerNameFromUrl,
	summarizeDiagnosticResults,
} from './infrastructure-helpers';
import { renderDiagnostics } from './infrastructure-diagnostics';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsSubsectionHeading } from './section-helpers';

export function renderInfrastructureManagementSection(context: InfrastructureSectionContext): void {
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
							new Notice(getDiagnosticsNoticeMessage(summarizeDiagnosticResults(results)));
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
