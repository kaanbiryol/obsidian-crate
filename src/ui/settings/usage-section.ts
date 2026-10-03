import { Setting } from 'obsidian';
import type CratePlugin from '../../main';
import type { UsageMetric } from '../../cloudflare/usage-service';
import type { UsageSnapshot } from '../../cloudflare/usage-snapshot';
import { createSettingsDisclosure } from './section-helpers';

export function renderUsageSection(containerEl: HTMLElement, plugin: CratePlugin): () => void {
	const accountId = plugin.settings.cloudflareDeployment?.accountId;
	if (!accountId) return () => {};
	const container = containerEl;
	const connection = plugin.cloudflareUsageConnection;
	let active = true;
	const current = () => active && plugin.settings.cloudflareDeployment?.accountId === accountId;
	container.createEl('p', { cls: 'setting-item-description', text: 'Usage reported by Cloudflare across your account, including other apps. Saved results stay visible until you refresh.' });
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
				if (current()) { status.setText(connection.needsAuthorization ? 'Select Reconnect under Account and devices to restore access. Your saved usage is kept.' : error instanceof Error ? error.message : 'Unable to refresh. Your saved results are still shown.'); }
			} finally {
				if (current()) {
					button.setDisabled(false).setButtonText('Refresh');
				}
			}
		}));
	const status = container.createDiv({ cls: 'setting-item-description' });
	status.setAttribute('aria-live', 'polite');
	const output = container.createDiv({ cls: 'crate-usage' });
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
		const today = new Date().toISOString().slice(0, 10);
		const dailyPeriod = day === today ? 'Today' : day;
		const month = date.toLocaleString('en', { month: 'long', timeZone: 'UTC', ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) });
		for (const group of snapshot.groups) {
			// Saved daily/monthly totals must retain their original reporting period.
			const section = output.createEl('section', { cls: 'crate-usage-group' });
			const header = section.createDiv({ cls: 'crate-usage-group-header' });
			const [name, ...period] = group.label.split(' · ');
			header.createEl('h4', { text: name, cls: 'crate-usage-group-title' });
			const compactPeriod = group.label.includes('this calendar month (UTC)') ? `${month} · UTC`
				: group.label.includes('today’s resource peaks') ? `${dailyPeriod} · peak storage`
					: group.label.includes('today (UTC)') ? `${dailyPeriod} · UTC` : period.join(' · ');
			if (compactPeriod) header.createSpan({ text: compactPeriod, cls: 'crate-usage-period' });
			if (group.error) section.createEl('p', { text: group.error, cls: 'crate-usage-unavailable' });
			for (const metric of group.metrics) renderMetric(section, metric);
		}

	}
	renderSnapshot(connection.snapshot);
	const notes = createSettingsDisclosure(container, 'About these estimates');
	notes.createEl('p', { cls: 'setting-item-description', text: 'Usage is compared with free allowances and is an estimate; paid plans may differ. Analytics can be delayed. Daily limits reset at midnight (UTC). R2 operations use the calendar month, which may differ from your billing period.' });
	notes.createEl('p', { cls: 'setting-item-description', text: 'Storage shows reported daily peaks, not monthly billed storage. R2 includes 10 gigabyte-months of standard storage; D1 includes 5 gigabytes. Infrequent access and other Cloudflare services are not covered.' });
	return () => { active = false; };
}

function renderMetric(container: HTMLElement, metric: UsageMetric): void {
	const used = metric.bytes ? `${(metric.used / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} GB` : metric.used.toLocaleString();
	const row = container.createDiv({ cls: 'crate-usage-metric' });
	const heading = row.createDiv({ cls: 'crate-usage-metric-header' });
	heading.createSpan({ text: metric.label, cls: 'crate-usage-label' });
	const value = heading.createDiv({ cls: 'crate-usage-value' });
	value.createSpan({ text: used, cls: 'crate-usage-used' });
	if (metric.allowance === undefined) return;
	value.createSpan({ text: ` / ${metric.allowance.toLocaleString()}`, cls: 'crate-usage-allowance' });
	const exceeded = metric.used > metric.allowance;
	if (exceeded) row.addClass('crate-usage-metric--exceeded');
	const progress = row.createEl('progress', { cls: 'crate-usage-progress' });
	progress.max = Math.max(1, metric.allowance);
	progress.value = Math.min(metric.used, progress.max);
	progress.setAttribute('aria-label', `${metric.label}: reported usage ${used} of ${metric.allowance.toLocaleString()} free allowance`);
	const footer = row.createDiv({ cls: 'crate-usage-metric-footer' });
	const percent = metric.allowance > 0 ? metric.used / metric.allowance * 100 : null;
	const percentLabel = percent === null ? 'No free allowance' : percent > 0 && percent < 0.1 ? '<0.1% used' : `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% used`;
	footer.createSpan({ text: percentLabel });
	if (exceeded) footer.createSpan({ text: 'Free allowance exceeded' });
}
