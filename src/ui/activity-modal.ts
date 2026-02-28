import { Modal, type App } from 'obsidian';
import type { CrateSettings, SyncHistoryEntry } from '../types';

export class ActivityModal extends Modal {
	private readonly settings: CrateSettings;

	constructor(app: App, settings: CrateSettings) {
		super(app);
		this.settings = settings;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('crate-activity-modal');
		contentEl.createEl('h2', { text: 'Sync activity' });

		const history = this.settings.syncHistory ?? [];

		if (history.length === 0) {
			contentEl.createEl('p', { text: 'No sync activity yet.', cls: 'crate-activity-empty' });
			return;
		}

		const list = contentEl.createDiv({ cls: 'crate-activity-list' });

		for (const entry of history) {
			const hasPaths = hasFilePaths(entry);

			if (hasPaths) {
				const details = list.createEl('details', { cls: 'crate-activity-details' });
				const summary = details.createEl('summary', { cls: 'crate-activity-row' });
				renderRowContent(summary, entry);
				renderFileDetails(details, entry);
			} else {
				const row = list.createDiv({ cls: 'crate-activity-row' });
				renderRowContent(row, entry);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function renderRowContent(el: HTMLElement, entry: SyncHistoryEntry): void {
	el.createSpan({ text: formatTimestamp(entry.timestamp), cls: 'crate-activity-time' });
	el.createSpan({ text: ' - ' });
	el.createSpan({ text: entry.type });
	el.createSpan({ text: ' - ' });
	el.createSpan({
		text: formatSummary(entry),
		cls: entry.success ? undefined : 'crate-activity-error',
	});
}

function hasFilePaths(entry: SyncHistoryEntry): boolean {
	return (entry.uploadedPaths?.length ?? 0) > 0
		|| (entry.downloadedPaths?.length ?? 0) > 0
		|| (entry.deletedPaths?.length ?? 0) > 0;
}

function renderFileDetails(container: HTMLElement, entry: SyncHistoryEntry): void {
	const fileList = container.createDiv({ cls: 'crate-activity-files' });

	const groups: Array<{ paths: string[]; cls: string; prefix: string }> = [
		{ paths: entry.uploadedPaths ?? [], cls: 'crate-file-upload', prefix: '\u2191' },
		{ paths: entry.downloadedPaths ?? [], cls: 'crate-file-download', prefix: '\u2193' },
		{ paths: entry.deletedPaths ?? [], cls: 'crate-file-delete', prefix: '\u00d7' },
	];

	for (const group of groups) {
		for (const filePath of group.paths) {
			const fileName = filePath.split('/').pop() ?? filePath;
			const row = fileList.createDiv({ cls: `crate-activity-file ${group.cls}` });
			row.createSpan({ text: group.prefix, cls: 'crate-file-prefix' });
			row.createSpan({ text: fileName, attr: { title: filePath } });
		}
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
