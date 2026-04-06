import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { SECRET_KEYS, type UsageMetric } from '../../plugin/types';
import { getErrorMessage, runButtonTask } from './action-helpers';
import { createSettingsSectionHeading } from './section-helpers';

export interface UsageSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
}

export function renderUsageSection(context: UsageSectionContext): void {
	const { containerEl } = context;
	createSettingsSectionHeading(containerEl, 'Usage');

	new Setting(containerEl)
		.setName('Refresh metrics')
		.setDesc('Fetch the latest usage metrics')
		.addButton(button => button
			.setButtonText('Refresh')
			.onClick(async () => {
				await runButtonTask({
					button,
					idleText: 'Refresh',
					runningText: 'Loading...',
					task: async () => {
						await loadUsageData(context, usageContainer);
					},
					onError: (error) => {
						const message = getErrorMessage(error);
						usageContainer.empty();
						usageContainer.createEl('p', {
							text: `Error: ${message}`,
							cls: 'setting-item-description',
						});
						new Notice(`Failed to load usage: ${message}`);
					},
				});
			}));

	const usageContainer = containerEl.createDiv({ cls: 'crate-usage-container' });
}

async function loadUsageData(context: UsageSectionContext, container: HTMLElement): Promise<void> {
	const { plugin } = context;
	container.empty();
	container.createEl('p', { text: 'Loading usage data...', cls: 'setting-item-description' });

	const apiToken = plugin.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
	const data = await plugin.usageService.getUsage(
		apiToken,
		plugin.syncRuntime.getApiClient()
	);
	container.empty();

	if (!data.available) {
		container.createEl('p', {
			text: data.error || 'Add your Cloudflare API token in the Configuration section above to view usage metrics.',
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
		renderServiceUsage(container, 'Workers (daily)', [
			{ label: 'Requests', metric: data.workers.requests },
		]);
	}

	if (data.r2) {
		renderServiceUsage(container, 'R2 storage', [
			{ label: 'Storage', metric: data.r2.storageBytes },
			{ label: 'Class A ops (monthly)', metric: data.r2.classAOps },
			{ label: 'Class B ops (monthly)', metric: data.r2.classBOps },
		]);
	}

	if (data.d1) {
		renderServiceUsage(container, 'D1 database (daily)', [
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

function renderServiceUsage(
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
			text: formatMetric(metric),
			cls: 'crate-usage-value',
		});

		const bar = row.createDiv({ cls: 'crate-usage-bar' });
		const fill = bar.createDiv({ cls: 'crate-usage-bar-fill' });
		fill.setCssProps({ width: `${Math.min(pct, 100)}%` });

		if (pct >= 90) {
			fill.addClass('crate-usage-bar-critical');
		} else if (pct >= 70) {
			fill.addClass('crate-usage-bar-warning');
		}
	}
}

function formatMetric(metric: UsageMetric): string {
	if (metric.unit === 'bytes') {
		return `${formatBytes(metric.current)} / ${formatBytes(metric.limit)}`;
	}
	return `${metric.current.toLocaleString()} / ${metric.limit.toLocaleString()}`;
}

function formatBytes(bytes: number): string {
	if (bytes === 0) {
		return '0 B';
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const value = bytes / Math.pow(1024, i);
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}
