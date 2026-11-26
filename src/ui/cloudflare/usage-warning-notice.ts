import { Notice } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import type { BilledUsageMetric } from '../../cloudflare/usage/service';
import type { UsageWarning } from '../../cloudflare/usage/usage-warnings';
import type { UsageWarningNotices } from '../../plugin/cloudflare/usage-warnings';

const NAMES: Record<BilledUsageMetric, string> = {
	'r2-class-a': 'R2 Class A operations',
	'r2-class-b': 'R2 Class B operations',
	'r2-storage': 'R2 storage',
};

function amount({ metric, percent }: UsageWarning): string {
	const format = (value: number) => metric.bytes
		? `${(value / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`
		: value.toLocaleString();
	return `${NAMES[metric.key]}: ${format(metric.used)} of ${format(metric.allowance)} (${Math.floor(percent)}%)`;
}

export function usageWarningNotices(plugin: Pick<CratePlugin, 'openSettingsTab'>): UsageWarningNotices {
	const link = (fragment: DocumentFragment, text: string) => {
		fragment.createEl('a', { text }).addEventListener('click', () => { plugin.openSettingsTab(); });
	};
	return {
		warn(warnings) {
			const fragment = new DocumentFragment();
			fragment.createDiv({ text: warnings.some(warning => warning.level === 100)
				? 'Cloudflare R2 usage passed its free allowance.'
				: 'Cloudflare R2 usage is close to its free allowance.' });
			const list = fragment.createEl('ul');
			for (const warning of warnings) list.createEl('li', { text: amount(warning) });
			fragment.createSpan({ text: 'Cloudflare bills R2 usage beyond the free allowance. ' });
			link(fragment, 'View usage');
			// Billing is worth a notice that stays until it is dismissed.
			new Notice(fragment, 0);
		},
		paused() {
			const fragment = new DocumentFragment();
			fragment.createSpan({ text: 'Cloudflare usage warnings are paused because Crate can no longer read usage. ' });
			link(fragment, 'Reconnect in settings');
			new Notice(fragment, 15000);
		},
	};
}
