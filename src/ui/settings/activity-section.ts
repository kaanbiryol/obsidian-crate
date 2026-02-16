import type CratePlugin from '../../main';
import type { SyncHistoryEntry } from '../../types';

export interface ActivitySectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
}

export function renderActivitySection(context: ActivitySectionContext): void {
	const { containerEl, plugin } = context;
	const history = plugin.settings.syncHistory ?? [];

	if (history.length === 0) {
		return;
	}

	containerEl.createEl('h3', { text: 'Recent activity' });

	const list = containerEl.createDiv({ cls: 'crate-activity-list' });

	for (const entry of history) {
		const row = list.createDiv({ cls: 'crate-activity-row' });
		row.createSpan({ text: formatTimestamp(entry.timestamp), cls: 'crate-activity-time' });
		row.createSpan({ text: ' - ' });
		row.createSpan({ text: entry.type });
		row.createSpan({ text: ' - ' });
		row.createSpan({
			text: formatSummary(entry),
			cls: entry.success ? undefined : 'crate-activity-error',
		});
	}
}

function formatTimestamp(iso: string): string {
	const d = new Date(iso);
	const month = d.toLocaleString(undefined, { month: 'short' });
	const day = d.getDate();
	const hours = String(d.getHours()).padStart(2, '0');
	const minutes = String(d.getMinutes()).padStart(2, '0');
	return `${month} ${day}, ${hours}:${minutes}`;
}

function formatSummary(entry: SyncHistoryEntry): string {
	if (!entry.success) {
		const parts = [`failed (${entry.errorCount} error${entry.errorCount !== 1 ? 's' : ''})`];
		if (entry.conflictCount > 0) {
			parts.push(`${entry.conflictCount} conflict${entry.conflictCount !== 1 ? 's' : ''}`);
		}
		return parts.join(', ');
	}

	if (entry.uploaded === 0 && entry.downloaded === 0 && entry.deleted === 0 && entry.conflictCount === 0) {
		return 'no changes';
	}

	const parts: string[] = [];
	if (entry.uploaded > 0) parts.push(`${entry.uploaded} up`);
	if (entry.downloaded > 0) parts.push(`${entry.downloaded} down`);
	if (entry.deleted > 0) parts.push(`${entry.deleted} del`);
	if (entry.conflictCount > 0) parts.push(`${entry.conflictCount} conflict${entry.conflictCount !== 1 ? 's' : ''}`);
	return parts.join(', ');
}
