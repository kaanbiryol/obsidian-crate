import type { ConflictRecord, SyncActivityProgress } from '../../sync/types';
import { renderEmptyState, renderFileMicroCard } from './rendering';

export function renderPendingPanel(container: HTMLElement, paths: string[], hasError = false, syncing = false, progress?: SyncActivityProgress | null): void {
	if (syncing || progress) {
		const notice = container.createDiv({ cls: 'crate-activity-transfer' });
		notice.setAttribute('role', 'status');
		notice.createEl('strong', { text: progress?.type === 'initial' ? 'Uploading your vault…' : 'Syncing files…' });
		notice.createEl('p', { text: progress && progress.total > 0
			? `${progress.current.toLocaleString()} of ${progress.total.toLocaleString()} files ${progress.type === 'initial' ? 'prepared for upload' : 'processed'}. Sync is still running.`
			: 'Checking your vault and preparing transfers…' });
		if (paths.length === 0) return;
	}
	if (paths.length === 0) {
		if (hasError) {
			renderEmptyState(container, 'inbox', 'No pending files', 'The last sync had errors. View history for details.');
		} else {
			renderEmptyState(container, 'check', 'All synced', 'Your vault is up to date.', 'success');
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

export function renderConflictsPanel(container: HTMLElement, conflicts: ConflictRecord[]): void {
	if (conflicts.length === 0) {
		renderEmptyState(container, 'shield-check', 'No conflicts', 'Everything looks good.', 'success');
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
