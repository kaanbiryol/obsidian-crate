import { setIcon } from 'obsidian';
import { groupHistory } from './history-groups';
import type { SyncHistoryEntry } from '../../sync/types';
import { renderEmptyState, renderFileMicroCard, type FileCardType } from './rendering';

export function renderHistoryPanel(container: HTMLElement, history: SyncHistoryEntry[]): void {
	if (history.length === 0) {
		renderEmptyState(container, 'clock', 'No activity yet', 'Sync history will appear here.');
		return;
	}

	const timeline = container.createDiv({ cls: 'crate-activity-timeline' });
	for (const group of groupHistory(history)) {
        const section = timeline.createEl('section', { cls: 'crate-history-day' });
        section.createEl('h3', { text: group.label, cls: 'crate-history-day-label' });
        for (const { entry, count } of group.rows) {
			const entryEl = section.createDiv({ cls: 'crate-history-entry' });
			if (!entry.success) entryEl.addClass('is-error');

			if (hasFilePaths(entry) || entry.errorCount > 0) {
				const details = entryEl.createEl('details', { cls: 'crate-history-details', attr: { 'data-history-key': `${entry.timestamp}:${entry.type}` } });
				const summary = details.createEl('summary', { cls: 'crate-history-card' });
				renderHistoryHeader(summary, entry, true);
				renderHistoryFiles(details, entry);
			} else {
				const card = entryEl.createDiv({ cls: 'crate-history-card' });
				renderHistoryHeader(card, entry, false, count);
			}
		}
    }
}

function renderHistoryHeader(element: HTMLElement, entry: SyncHistoryEntry, expandable: boolean, count = 1): void {
	const header = element.createDiv({ cls: 'crate-history-header' });
	if (expandable) {
		const chevron = header.createDiv({ cls: 'crate-history-chevron', attr: { 'aria-hidden': 'true' } });
		setIcon(chevron, 'chevron-right');
	}
	renderHistorySummary(header, entry, count);
	const meta = header.createDiv({ cls: 'crate-history-meta' });
	if (entry.type !== 'sync') {
        meta.createSpan({ text: entry.type === 'initial' ? 'Initial sync' : 'Full sync', cls: 'crate-history-type' });
    }
	const timestamp = meta.createSpan({ text: formatTimestamp(entry.timestamp), cls: 'crate-history-time' });
    timestamp.setAttribute('title', new Intl.DateTimeFormat(undefined, {
        dateStyle: 'long', timeStyle: 'long', hourCycle: 'h23',
    }).format(new Date(entry.timestamp)));
}

function renderHistoryFiles(container: HTMLElement, entry: SyncHistoryEntry): void {
	const filesEl = container.createDiv({ cls: 'crate-history-files' });
	for (const error of entry.errors ?? []) {
		filesEl.createDiv({ text: error, cls: 'crate-history-error' });
	}
	if (entry.errorCount > (entry.errors?.length ?? 0)) {
		filesEl.createDiv({ text: entry.errors?.length
			? `Showing ${entry.errors.length} of ${entry.errorCount} errors.`
			: 'Error details were not saved for this sync. Run sync again to record them.' });
	}
	const groups: Array<{ paths: string[]; type: FileCardType; total: number; label: string }> = [
		{ paths: entry.uploadedPaths ?? [], type: 'upload', total: entry.uploaded, label: 'uploaded' },
		{ paths: entry.downloadedPaths ?? [], type: 'download', total: entry.downloaded, label: 'downloaded' },
		{ paths: entry.mergedPaths ?? [], type: 'merge', total: entry.merged, label: 'merged' },
		{ paths: entry.deletedPaths ?? [], type: 'delete', total: entry.deleted, label: 'deleted' },
		{ paths: entry.conflictPaths ?? [], type: 'conflict', total: entry.conflictCount, label: 'conflicting' },
	];
	for (const group of groups) {
		for (const filePath of group.paths) renderFileMicroCard(filesEl, filePath, group.type);
		if (group.total > group.paths.length) {
			filesEl.createDiv({ text: `Showing ${group.paths.length} of ${group.total} ${group.label} files.`, cls: 'crate-file-path' });
		}
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
	return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(date);
}

function renderHistorySummary(header: HTMLElement, entry: SyncHistoryEntry, count: number): void {
    const summary = header.createDiv({ cls: 'crate-history-summary' });
    if (!entry.success) {
        summary.createSpan({
            text: `Failed (${entry.errorCount} error${entry.errorCount !== 1 ? 's' : ''})`,
            cls: 'crate-history-summary-error',
        });
    }
    const metrics = [
        { count: entry.uploaded, label: 'uploaded' },
        { count: entry.downloaded, label: 'downloaded' },
        { count: entry.merged, label: 'merged' },
        { count: entry.deleted, label: 'deleted' },
        { count: entry.conflictCount, label: entry.conflictCount === 1 ? 'conflict' : 'conflicts' },
        { count: entry.resolvedRaceCount ?? 0, label: entry.resolvedRaceCount === 1 ? 'race resolved' : 'races resolved' },
    ].filter(metric => metric.count > 0);
    for (const [index, metric] of metrics.entries()) {
        if (index > 0) summary.createSpan({ text: '·', cls: 'crate-history-separator', attr: { 'aria-hidden': 'true' } });
        const stat = summary.createSpan({ cls: 'crate-history-stat' });
        const transfer = ['uploaded', 'downloaded', 'merged', 'deleted'].includes(metric.label);
        if (transfer) stat.createSpan({ text: metric.label[0]!.toUpperCase() + metric.label.slice(1) });
        stat.createSpan({ text: metric.count.toLocaleString(), cls: 'crate-history-count' });
        if (transfer && metrics.length === 1) stat.createSpan({ text: metric.count === 1 ? 'file' : 'files' });
        if (!transfer) stat.createSpan({ text: metric.label });
    }
    if (entry.success && metrics.length === 0) {
        summary.createSpan({ text: count > 1 ? `No changes · ${count.toLocaleString()} checks` : 'No changes', cls: 'crate-history-unchanged' });
    }
}
