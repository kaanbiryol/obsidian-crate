import type { PendingActions } from './pending-actions';
import { formatSyncProgress } from './progress-label';
import type { ConflictRecord, SyncActivityProgress, SyncState } from '../../sync/types';
import { renderEmptyState, renderFileMicroCard } from './rendering';
import { renderPendingBrowser, type PendingDiffLoader, type PendingBrowserState } from './pending-browser';

export function renderPendingPanel(container: HTMLElement, paths: string[], hasError = false, syncing = false, progress?: SyncActivityProgress | null, lastSyncLabel = 'Your vault is up to date.', state?: SyncState, loadDiff?: PendingDiffLoader, browserState?: PendingBrowserState, actions?: PendingActions): void {
	container.toggleClass('has-file-browser', !!loadDiff && paths.length > 0 && !syncing && !progress);
	if (syncing || progress) {
        const loading = container.createDiv({ cls: 'crate-activity-loading' });
        loading.setAttribute('role', 'status');
        loading.setAttribute('aria-live', 'polite');
        const spinner = loading.createSpan({ cls: 'crate-activity-spinner' });
        spinner.setAttribute('aria-hidden', 'true');
        const text = formatSyncProgress(progress, state?.work);
        loading.createSpan({
            cls: 'crate-activity-loading-label',
            text,
        }).setAttribute('title', text);
        return;
	}
	if (paths.length === 0) {
		if (hasError) {
			renderEmptyState(container, 'inbox', 'No pending files', 'The last sync had errors. View history for details.');
		} else if (state?.status === 'offline') {
			renderEmptyState(container, 'wifi-off', 'You’re offline', 'Connect to the internet to check for changes.');
		} else if (state && !state.lastSync) {
			renderEmptyState(container, 'refresh-cw', 'No completed sync yet', 'No successful sync is recorded on this device.');
		} else {
			renderEmptyState(container, 'check', 'All synced', lastSyncLabel, 'success');
		}
		return;
	}

	if (loadDiff) {
		renderPendingBrowser(container, paths, loadDiff, browserState, actions);
		return;
	}

	const uploads: string[] = [];
	const deletes: string[] = [];
	for (const raw of paths) {
		if (raw.startsWith('delete:')) deletes.push(raw.substring(7));
		else uploads.push(raw);
	}

	const list = container.createDiv({ cls: 'crate-activity-list' });
	for (const filePath of uploads) {
		renderFileMicroCard(list, filePath, 'upload');
	}
	for (const filePath of deletes) {
		renderFileMicroCard(list, filePath, 'delete');
	}
}

export function renderConflictsPanel(container: HTMLElement, conflicts: ConflictRecord[], checking: boolean, onReview?: (conflict: ConflictRecord) => void): void {
	if (conflicts.length === 0) {
		renderEmptyState(container, checking ? 'search' : 'shield-check', checking ? 'Checking for conflicts…' : 'No conflicts', checking ? '' : 'There are no files requiring attention.', checking ? 'accent' : 'success');
		return;
	}

	const list = container.createDiv({ cls: 'crate-activity-list' });
	for (const conflict of conflicts) {
		const row = list.createDiv({ cls: 'crate-conflict-row' });
        const kind = conflict.cause === 'incoming-review' ? 'File review required'
            : conflict.copySide === 'remote' ? 'Incoming server copy' : 'Saved conflict copy';
        const date = new Date(conflict.createdAt);
        const now = new Date();
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const day = date.toDateString() === now.toDateString() ? 'Today'
            : date.toDateString() === yesterday.toDateString() ? 'Yesterday'
                : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric',
                    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) });
        const timestamp = Number.isNaN(date.getTime()) ? ''
            : `${day}, ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
        const card = renderFileMicroCard(row, conflict.originalPath, 'conflict',
            [kind, timestamp].filter(Boolean).join(' · '));
        const title = card.querySelector<HTMLElement>('.crate-file-name');
        if (title) {
            title.empty();
            title.title = conflict.conflictPath;
            const parts = conflict.originalPath.split('/');
            const filename = parts.pop()!;
            if (parts.length) title.createSpan({ text: `${parts.join('/')}/`, cls: 'crate-conflict-row-folder' });
            title.createSpan({ text: filename });
        }

		if (onReview) {
			const review = row.createEl('button', { text: 'Review', cls: 'crate-conflict-review-button crate-activity-action', attr: { type: 'button', 'aria-label': `Review conflict for ${conflict.originalPath}` } });
			review.addEventListener('click', () => onReview(conflict));
		}
	}
}
