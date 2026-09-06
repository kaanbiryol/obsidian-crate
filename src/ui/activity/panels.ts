import type { ConflictRecord } from '../../sync/types';
import { renderEmptyState, renderFileMicroCard } from './rendering';

export function renderPendingPanel(container: HTMLElement, paths: string[]): void {
	if (paths.length === 0) {
		renderEmptyState(container, 'check', 'All synced', 'Your vault is up to date.', 'success');
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
