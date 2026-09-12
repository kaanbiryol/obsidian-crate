import { renderServerResetSetting } from './server-reset-setting';
import { Notice, Setting } from 'obsidian';
import { runSyncDiagnostics } from '../../sync/diagnostics';
import { getErrorMessage, runButtonTask } from './action-helpers';
import {
	getDiagnosticsNoticeMessage,
	summarizeDiagnosticResults,
} from './infrastructure-helpers';
import { renderDiagnostics } from './infrastructure-diagnostics';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsSubsectionHeading } from './section-helpers';
import { buildDiagnosticsSettingsStateKey } from '../../plugin/settings-ui-state';

export function renderInfrastructureManagementSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin, isConfigured } = context;

	const deployment = plugin.settings.cloudflareDeployment;
	const hasPendingRecovery = deployment?.accountId && deployment.d1DatabaseId
		&& (deployment.reset || !deployment.lastDeployedVersion);
	if (isConfigured || hasPendingRecovery) {
		createSettingsSubsectionHeading(containerEl, 'Server management');
		renderServerResetSetting(containerEl, plugin);
	}

	const diagnosticsContainer = containerEl.createDiv({ cls: 'crate-diagnostics' });
	diagnosticsContainer.hide();
	const cachedDiagnostics = plugin.settingsUiState.diagnostics;
	if (isConfigured && cachedDiagnostics && cachedDiagnostics.key === buildDiagnosticsSettingsStateKey(plugin.settings)) {
		renderDiagnostics(diagnosticsContainer, cachedDiagnostics.results);
	}

	if (isConfigured) {
		const diagnosticsSetting = new Setting(containerEl)
			.setName('Run diagnostics')
			.setDesc('Check server compatibility, sign-in, health, and access to the synced file list.')
			.addButton(button => button
				.setButtonText('Run')
				.onClick(async () => {
					const originalDesc = diagnosticsSetting.descEl.textContent || '';

					await runButtonTask({
						button,
						idleText: 'Run',
						runningText: 'Running...',
						progressEl: diagnosticsSetting.descEl,
						progressMessage: 'Running diagnostics...',
						task: async () => runSyncDiagnostics(plugin.syncRuntime.getApiClient()),
						onSuccess: (results) => {
							plugin.settingsUiState.diagnostics = {
								key: buildDiagnosticsSettingsStateKey(plugin.settings),
								results,
							};
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

		new Setting(containerEl)
			.setName('Server address')
			.setDesc('The Cloudflare address this vault uses for sync.')
			.addText(text => text
				.setValue(plugin.settings.workerUrl)
				.setDisabled(true));

		new Setting(containerEl)
			.setName('Manage server')
			.setDesc('Open the Cloudflare dashboard to view logs and manage your server resources.')
			.addButton(button => button
				.setButtonText('Open Cloudflare')
				.onClick(() => {
					window.open('https://dash.cloudflare.com/', '_blank', 'noopener,noreferrer');
				}));
	}
}
