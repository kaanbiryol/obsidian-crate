import type { PendingDiff } from '../../sync/pending-diff';
import { buildDiff } from './diff-model';
import { renderDiffLines } from './diff-renderer';

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
        const message = container.createDiv({ cls: 'crate-diff-message', attr: snapshot.kind === 'modified' ? { title: 'Touched files stay listed until sync, even when their contents match the last-synced copy.' } : {} });
        message.createDiv({ cls: 'crate-browser-empty-title', text: snapshot.kind === 'modified' ? 'Unchanged' : snapshot.kind === 'added' ? 'New empty file' : 'Empty file deleted' });
        message.createDiv({ text: snapshot.kind === 'modified' ? 'Matches the last-synced copy.'
                : snapshot.kind === 'added' ? 'This empty file was added on this device since the last sync.' : 'This empty file was deleted on this device.' });
    } else {
        const stats = header.createDiv({ cls: 'crate-diff-stats', attr: { 'aria-label': `${diff.added} added lines, ${diff.removed} removed lines` } });
        stats.createSpan({ text: `+${diff.added}`, cls: 'is-added' });
        stats.createSpan({ text: `−${diff.removed}`, cls: 'is-removed' });
        renderDiffLines(container, diff.lines, `Changes for ${path}`);
    }
}

function formatSize(size: number): string {
    return size < 1_000 ? `${size} B` : `${Math.round(size / 1_000)} KB`;
}
