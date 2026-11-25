import { renderPendingSyncButton, type PendingActions } from './pending-actions';
import { formatShortSyncProgress, formatSyncProgress, syncProgressFraction } from './progress-label';
import type { ConflictRecord, SyncActivityProgress, SyncState } from '../../sync/types';
import { renderEmptyState, renderFileMicroCard, renderLoadingState } from './rendering';
import { renderPendingBrowser, type PendingChecks, type PendingDiffLoader, type PendingBrowserState } from './pending-browser';

interface PendingPanelOptions {
	paths: string[];
	loadDiff: PendingDiffLoader;
	state?: SyncState;
	progress?: SyncActivityProgress | null;
	lastSyncLabel?: string;
	browserState?: PendingBrowserState;
	actions?: PendingActions;
}

/** Returns the file browser's checks when the panel shows one. With actions, every other
 * state gets the sync button too, so the tab can always sync or stop. */
export function renderPendingPanel(container: HTMLElement, { paths, loadDiff, state, progress, lastSyncLabel = 'Your vault is up to date.', browserState, actions }: PendingPanelOptions): PendingChecks | undefined {
	const hasError = state?.status === 'error';
	const syncing = state?.status === 'syncing';
	const checking = state?.initializing && !hasError && state.status !== 'offline';
	// With actions, a running sync keeps pending files in view, locked, with progress in the list's footer.
	const lockedBrowser = (syncing || !!progress) && paths.length > 0 && !!actions;
	container.toggleClass('has-file-browser', lockedBrowser || paths.length > 0 && !syncing && !progress && !checking);
	const withSyncButton = (parent: HTMLElement): PendingChecks | undefined => {
		if (!actions) return;
		const update = renderPendingSyncButton(parent, actions.sync);
		return { start() {}, pause() {}, dispose() {}, setSyncProgress() {}, updateAction: update };
	};
	if (lockedBrowser) {
		const checks = renderPendingBrowser(container, paths, loadDiff, browserState, actions);
		const work = progress?.work ?? state?.work;
		checks.setSyncProgress({ label: formatShortSyncProgress(progress, work), fraction: syncProgressFraction(work) });
		return checks;
	}
	if (syncing || progress) return withSyncButton(renderLoadingState(container, formatSyncProgress(progress, state?.work)));
	if (checking) return withSyncButton(renderLoadingState(container, 'Checking local files…'));
	if (paths.length === 0) {
		let empty: HTMLElement;
		if (hasError) {
			empty = renderEmptyState(container, 'inbox', 'No pending files', 'The last sync had errors. View history for details.');
		} else if (state?.status === 'offline') {
			empty = renderEmptyState(container, 'wifi-off', 'Server unavailable', 'Check the server connection above, then try again.');
		} else if (state && !state.lastSync) {
			empty = renderEmptyState(container, 'refresh-cw', 'No completed sync yet', 'No successful sync is recorded on this device.');
		} else {
			empty = renderEmptyState(container, 'check', 'All synced', lastSyncLabel, 'success');
		}
		return withSyncButton(empty);
	}

	return renderPendingBrowser(container, paths, loadDiff, browserState, actions);
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
