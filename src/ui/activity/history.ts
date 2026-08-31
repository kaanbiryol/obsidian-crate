import { setIcon } from 'obsidian';
import type { SyncHistoryEntry } from '../../sync/types';
import { renderEmptyState, renderFileMicroCard, type FileCardType } from './rendering';

export function renderHistoryPanel(container: HTMLElement, history: SyncHistoryEntry[]): void {
	if (history.length === 0) {
		renderEmptyState(container, 'clock', 'No activity yet', 'Sync history will appear here.');
		return;
	}

	const timeline = container.createDiv({ cls: 'crate-activity-timeline' });
	for (const entry of history) {
		const entryEl = timeline.createDiv({ cls: 'crate-history-entry' });
		const dot = entryEl.createDiv({ cls: 'crate-history-dot' });
		if (!entry.success) dot.addClass('is-error');

		if (hasFilePaths(entry)) {
			const details = entryEl.createEl('details', { cls: 'crate-history-details' });
			const summary = details.createEl('summary', { cls: 'crate-history-card' });
			renderHistoryHeader(summary, entry, true);
			renderHistoryFiles(details, entry);
		} else {
			const card = entryEl.createDiv({ cls: 'crate-history-card' });
			renderHistoryHeader(card, entry, false);
		}
	}
}

function renderHistoryHeader(element: HTMLElement, entry: SyncHistoryEntry, expandable: boolean): void {
	const header = element.createDiv({ cls: 'crate-history-header' });
	const meta = header.createDiv({ cls: 'crate-history-meta' });
	meta.createSpan({ text: entry.type, cls: 'crate-history-type' });
	meta.createSpan({ text: formatTimestamp(entry.timestamp), cls: 'crate-history-time' });
	header.createSpan({
		text: formatSummary(entry),
		cls: `crate-history-summary${entry.success ? '' : ' crate-history-summary-error'}`,
	});
	if (expandable) {
		const chevron = header.createDiv({ cls: 'crate-history-chevron' });
		setIcon(chevron, 'chevron-right');
	}
}

function renderHistoryFiles(container: HTMLElement, entry: SyncHistoryEntry): void {
	const filesEl = container.createDiv({ cls: 'crate-history-files' });
	const groups: Array<{ paths: string[]; type: FileCardType }> = [
		{ paths: entry.uploadedPaths ?? [], type: 'upload' },
		{ paths: entry.downloadedPaths ?? [], type: 'download' },
		{ paths: entry.mergedPaths ?? [], type: 'merge' },
		{ paths: entry.deletedPaths ?? [], type: 'delete' },
		{ paths: entry.conflictPaths ?? [], type: 'conflict' },
	];
	for (const group of groups) {
		for (const filePath of group.paths) renderFileMicroCard(filesEl, filePath, group.type);
	}
	for (const race of entry.resolvedRaces ?? []) {
		renderFileMicroCard(
			filesEl,
			race.path,
			race.resolution === 'kept-local-edit' ? 'upload' : 'download',
			race.resolution === 'kept-local-edit'
				? 'Edit/delete race: kept local edit'
				: 'Edit/delete race: restored remote edit',
		);
	}
}

function hasFilePaths(entry: SyncHistoryEntry): boolean {
	return (entry.uploadedPaths?.length ?? 0) > 0
		|| (entry.downloadedPaths?.length ?? 0) > 0
		|| (entry.mergedPaths?.length ?? 0) > 0
		|| (entry.deletedPaths?.length ?? 0) > 0
		|| (entry.conflictPaths?.length ?? 0) > 0
		|| (entry.resolvedRaces?.length ?? 0) > 0;
}

function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	const month = date.toLocaleString(undefined, { month: 'short' });
	const day = date.getDate();
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	return `${month} ${day}, ${hours}:${minutes}`;
}

function formatSummary(entry: SyncHistoryEntry): string {
	if (!entry.success) {
		const parts = [`failed (${entry.errorCount} error${entry.errorCount !== 1 ? 's' : ''})`];
		if (entry.merged > 0) parts.push(`${entry.merged} merged`);
		if (entry.conflictCount > 0) {
			parts.push(`${entry.conflictCount} conflict${entry.conflictCount !== 1 ? 's' : ''}`);
		}
		if ((entry.resolvedRaceCount ?? 0) > 0) {
			parts.push(`${entry.resolvedRaceCount} race${entry.resolvedRaceCount !== 1 ? 's' : ''} resolved`);
		}
		return parts.join(', ');
	}

	if (
		entry.uploaded === 0
		&& entry.downloaded === 0
		&& entry.merged === 0
		&& entry.deleted === 0
		&& entry.conflictCount === 0
		&& (entry.resolvedRaceCount ?? 0) === 0
	) return 'no changes';

	const parts: string[] = [];
	if (entry.uploaded > 0) parts.push(`${entry.uploaded} up`);
	if (entry.downloaded > 0) parts.push(`${entry.downloaded} down`);
	if (entry.merged > 0) parts.push(`${entry.merged} merged`);
	if (entry.deleted > 0) parts.push(`${entry.deleted} del`);
	if (entry.conflictCount > 0) {
		parts.push(`${entry.conflictCount} conflict${entry.conflictCount !== 1 ? 's' : ''}`);
	}
	if ((entry.resolvedRaceCount ?? 0) > 0) {
		parts.push(`${entry.resolvedRaceCount} race${entry.resolvedRaceCount !== 1 ? 's' : ''} resolved`);
	}
	return parts.join(', ');
}
