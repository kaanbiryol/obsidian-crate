import type { PendingDiff } from '../../sync/pending/pending-diff';
import { buildDiff } from './diff-model';
import { diffCountsLabel, renderDiffCounts, renderDiffLines } from './diff-renderer';
import { formatSize } from '../shared/format';

export function renderDiffPreview(container: HTMLElement, snapshot: PendingDiff, path: string, header: HTMLElement): void {
	if (snapshot.unavailable || snapshot.before === undefined || snapshot.after === undefined) {
		container.createDiv({ cls: 'crate-diff-message', text: snapshot.unavailable ?? 'Preview unavailable.' });
		container.createDiv({ cls: 'crate-diff-footnote', text: `${formatSize(snapshot.beforeSize)} at last sync · ${formatSize(snapshot.afterSize)} on this device` });
		return;
	}
	container.createDiv({ cls: 'crate-diff-footnote', text: 'Changes since last sync on this device' });
	const diff = buildDiff(snapshot.before, snapshot.after);
	if (diff.limited) {
		container.createDiv({ cls: 'crate-diff-message', text: 'This comparison is too large to preview. Open the file to review it.' });
		return;
	}
	if (diff.added === 0 && diff.removed === 0) {
		const message = container.createDiv({ cls: 'crate-diff-message' });
		message.createDiv({ cls: 'crate-browser-empty-title', text: snapshot.kind === 'modified' ? 'Unchanged' : snapshot.kind === 'added' ? 'New empty file' : 'Empty file deleted' });
		message.createDiv({ text: snapshot.kind === 'modified' ? 'Matches the last-synced copy.'
				: snapshot.kind === 'added' ? 'This empty file was added on this device since the last sync.' : 'This empty file was deleted on this device.' });
	} else {
		renderDiffCounts(header.createDiv({ cls: 'crate-diff-stats', attr: { 'aria-label': diffCountsLabel(diff) } }), diff);
		renderDiffLines(container, diff.lines, `Changes for ${path}`);
	}
}
