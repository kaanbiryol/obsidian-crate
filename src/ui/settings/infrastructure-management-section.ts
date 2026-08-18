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

	createSettingsSubsectionHeading(containerEl, 'Infrastructure management');

	const diagnosticsContainer = containerEl.createDiv({ cls: 'crate-diagnostics' });
	diagnosticsContainer.hide();
	const cachedDiagnostics = plugin.settingsUiState.diagnostics;
	if (isConfigured && cachedDiagnostics && cachedDiagnostics.key === buildDiagnosticsSettingsStateKey(plugin.settings)) {
		renderDiagnostics(diagnosticsContainer, cachedDiagnostics.results);
	}

	if (isConfigured) {
		new Setting(containerEl)
			.setName('Worker URL')
			.setDesc('Current sync endpoint')
			.addText(text => text
				.setValue(plugin.settings.workerUrl)
				.setDisabled(true));

		const diagnosticsSetting = new Setting(containerEl)
			.setName('Run diagnostics')
			.setDesc('Check server compatibility, authentication, health, and manifest access')
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
			.setName('Manage server')
			.setDesc('Use the Cloudflare dashboard to view logs, update the deployment, or delete its resources')
			.addButton(button => button
				.setButtonText('Open Cloudflare')
				.onClick(() => {
					window.open('https://dash.cloudflare.com/', '_blank', 'noopener,noreferrer');
				}));
	}
}
