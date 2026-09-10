import type { ConflictRecord, SyncActivityProgress } from '../../sync/types';
import { renderEmptyState, renderFileMicroCard } from './rendering';

export function renderPendingPanel(container: HTMLElement, paths: string[], hasError = false, syncing = false, progress?: SyncActivityProgress | null, lastSyncLabel = 'Your vault is up to date.'): void {
	if (syncing || progress) {
        const loading = container.createDiv({ cls: 'crate-activity-loading' });
        loading.setAttribute('role', 'status');
        loading.setAttribute('aria-live', 'polite');
        const spinner = loading.createSpan({ cls: 'crate-activity-spinner' });
        spinner.setAttribute('aria-hidden', 'true');
        loading.createSpan({
            cls: 'crate-activity-loading-label',
            text: progress?.type === 'initial' ? 'Uploading vault…' : 'Syncing…',
        });
        return;
	}
	if (paths.length === 0) {
		if (hasError) {
			renderEmptyState(container, 'inbox', 'No pending files', 'The last sync had errors. View history for details.');
		} else {
			renderEmptyState(container, 'check', 'All synced', lastSyncLabel, 'success');
		}
		return;
	}

	const uploads: string[] = [];
	const deletes: string[] = [];
	for (const raw of paths) {
		if (raw.startsWith('delete:')) deletes.push(raw.substring(7));
		else uploads.push(raw);
	}

	const list = container.createDiv({ cls: 'crate-activity-list' });
	for (const filePath of uploads) renderFileMicroCard(list, filePath, 'upload');
	for (const filePath of deletes) renderFileMicroCard(list, filePath, 'delete');
}

export function renderConflictsPanel(container: HTMLElement, conflicts: ConflictRecord[], lastSyncLabel: string): void {
	if (conflicts.length === 0) {
		renderEmptyState(container, 'shield-check', 'No conflicts', lastSyncLabel, 'success');
		return;
	}

	const list = container.createDiv({ cls: 'crate-activity-list' });
	for (const conflict of conflicts) {
		renderFileMicroCard(
			list,
			conflict.conflictPath,
			'conflict',
			`Original: ${conflict.originalPath} · ${conflict.copySide === 'remote' ? 'Incoming server copy; original retained' : 'Local-only copy'}`,
		);
	}
}
