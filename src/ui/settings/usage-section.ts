import { Setting } from 'obsidian';
import type CratePlugin from '../../main';
import type { UsageMetric } from '../../cloudflare/usage-service';
import type { UsageSnapshot } from '../../cloudflare/usage-snapshot';
import { isCloudflareOAuthConfigured } from '../../cloudflare/oauth-config';
import { createSettingsDisclosure } from './section-helpers';

export function renderUsageSection(containerEl: HTMLElement, plugin: CratePlugin, connectionContainer?: HTMLElement): () => void {
	const accountId = plugin.settings.cloudflareDeployment?.accountId;
	if (!accountId) return () => {};
	const container = createSettingsDisclosure(containerEl, 'Cloudflare usage');
	const connection = plugin.cloudflareUsageConnection;
	let active = true;
	const current = () => active && plugin.settings.cloudflareDeployment?.accountId === accountId;
	container.createEl('p', { cls: 'setting-item-description', text: 'Usage reported by Cloudflare across your account, including other apps. Saved results stay visible until you refresh.' });
	const reconnect = new Setting(connectionContainer ?? container)
		.setName('Cloudflare connection')
		.setDesc('Sign in again to restore Cloudflare access. Saved usage stays visible.')
		.addButton(button => button.setButtonText('Reconnect Cloudflare')
			.setDisabled(!isCloudflareOAuthConfigured()).onClick(async () => {
				try {
					await connection.connect();
					if (current()) status.setText('Finish connecting in your browser.');
				} catch (error) {
					if (current()) { reconnect.settingEl.hidden = connection.connected && !connection.needsAuthorization; status.setText(error instanceof Error ? error.message : 'Could not connect usage.'); }
				}
			}));
	reconnect.settingEl.hidden = connection.connected && !connection.needsAuthorization;
	const controls = new Setting(container).setName('Usage metrics')
		.addButton(button => button.setButtonText('Refresh').setDisabled(!connection.connected).onClick(async () => {
			status.setText('Refreshing usage…');
			button.setDisabled(true).setButtonText('Refreshing…');
			try {
				const groups = await connection.fetchUsage();
				if (!current()) return;
				renderSnapshot(connection.snapshot ?? { accountId, updatedAt: Date.now(), groups });
				status.empty();
			} catch (error) {
				if (current()) { reconnect.settingEl.hidden = connection.connected && !connection.needsAuthorization; status.setText(error instanceof Error ? error.message : 'Unable to refresh. Your saved results are still shown.'); }
			} finally {
				if (current()) {
					reconnect.settingEl.hidden = connection.connected && !connection.needsAuthorization;
					button.setDisabled(false).setButtonText('Refresh');
				}
			}
		}));
	const status = container.createDiv({ cls: 'setting-item-description' });
	status.setAttribute('aria-live', 'polite');
	const output = container.createDiv();
	function renderSnapshot(snapshot: UsageSnapshot | null): void {
		output.empty();
		if (!snapshot) {
			controls.setDesc('No saved usage yet. Refresh to load your first snapshot.');
			return;
		}
		const date = new Date(snapshot.updatedAt);
		const minutes = Math.max(0, Math.floor((Date.now() - snapshot.updatedAt) / 60_000));
		const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`;
		const timestamp = date.toISOString().slice(0, 19).replace('T', ' ');
		controls.setDesc(`Last updated ${ago} · ${timestamp} UTC. Refresh for the latest usage.`);
		const day = date.toISOString().slice(0, 10);
		for (const group of snapshot.groups) {
			// Saved daily/monthly totals must retain their original reporting period.
			const label = group.label.replace('today (UTC)', `${day} · since 00:00 UTC`)
				.replace('this calendar month (UTC)', `since ${day.slice(0, 7)}-01 00:00 UTC`)
				.replace('today’s resource peaks', `resource peaks since ${day} 00:00 UTC`);
			new Setting(output).setName(label).setHeading();
			if (group.error) output.createEl('p', { text: group.error, cls: 'setting-item-description' });
			for (const metric of group.metrics) renderMetric(output, metric);
		}
	}
	renderSnapshot(connection.snapshot);
	const notes = createSettingsDisclosure(container, 'About these estimates');
	notes.createEl('p', { cls: 'setting-item-description', text: 'Remaining amounts compare usage with free allowances; paid plans may differ. Analytics can be delayed. Daily limits reset at midnight (UTC). R2 operations use the calendar month, which may differ from your billing period.' });
	notes.createEl('p', { cls: 'setting-item-description', text: 'Storage shows reported daily peaks, not monthly billed storage. R2 includes 10 gigabyte-months of standard storage; D1 includes 5 gigabytes. Infrequent access and other Cloudflare services are not covered.' });
	return () => { active = false; };
}

function renderMetric(container: HTMLElement, metric: UsageMetric): void {
	const used = metric.bytes ? `${(metric.used / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} GB` : metric.used.toLocaleString();
	const setting = new Setting(container).setName(metric.label).setClass('crate-usage-metric');
	if (metric.allowance === undefined) {
		setting.setDesc(`Reported: ${used}`);
		return;
	}
	const remaining = Math.max(0, metric.allowance - metric.used);
	setting.setDesc(`Reported: ${used}\nFree allowance: ${metric.allowance.toLocaleString()}\nEstimated remaining: ${remaining.toLocaleString()}${metric.used > metric.allowance ? ' · Free allowance exceeded' : ''}`);
	const progress = setting.controlEl.createEl('progress');
	progress.max = metric.allowance;
	progress.value = Math.min(metric.used, metric.allowance);
	progress.setAttribute('aria-label', `${metric.label}: reported usage ${used} of ${metric.allowance.toLocaleString()} free allowance`);
}
