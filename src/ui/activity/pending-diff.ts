import type { PendingDiff } from '../../sync/pending-diff';
import { buildDiff, groupDiffContext, type DiffLine } from './diff-model';

function renderLine(container: HTMLElement, line: DiffLine): void {
    const row = container.createDiv({ cls: `crate-diff-line is-${line.kind}` });
    row.createSpan({ text: line.before?.toString() ?? '', cls: 'crate-diff-number', attr: { 'aria-hidden': 'true' } });
    row.createSpan({ text: line.after?.toString() ?? '', cls: 'crate-diff-number', attr: { 'aria-hidden': 'true' } });
    row.createSpan({ text: line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ', cls: 'crate-diff-sign' });
    row.createEl('code', { text: line.text || ' ', cls: 'crate-diff-text' });
}

export function renderDiffPreview(container: HTMLElement, snapshot: PendingDiff, path: string): void {
    const header = container.createDiv({ cls: 'crate-diff-header' });
    const labels = header.createDiv({ cls: 'crate-diff-labels' });
    labels.createSpan({ text: 'Server' });
    labels.createSpan({ text: '→', attr: { 'aria-hidden': 'true' } });
    labels.createSpan({ text: snapshot.kind === 'deleted' ? 'Deleted locally' : 'This device' });
    if (snapshot.kind === 'added') labels.createSpan({ text: 'New file', cls: 'crate-diff-kind' });
    if (snapshot.unavailable || snapshot.before === undefined || snapshot.after === undefined) {
        container.createDiv({ cls: 'crate-diff-message', text: snapshot.unavailable ?? 'Preview unavailable.' });
        container.createDiv({ cls: 'crate-diff-footnote', text: `${formatSize(snapshot.beforeSize)} on server · ${formatSize(snapshot.afterSize)} on this device` });
        return;
    }
    const diff = buildDiff(snapshot.before, snapshot.after);
    if (diff.limited) {
        container.createDiv({ cls: 'crate-diff-message', text: 'This file has too many lines to preview.' });
        return;
    }
    if (diff.added === 0 && diff.removed === 0) {
        const message = container.createDiv({ cls: 'crate-diff-message' });
        message.createDiv({ cls: 'crate-browser-empty-title', text: snapshot.kind === 'modified' ? 'Unchanged' : snapshot.kind === 'added' ? 'New empty file' : 'Empty file deleted' });
        message.createDiv({ text: snapshot.kind === 'modified' ? 'Contents match the server. This file stays listed until sync.'
                : snapshot.kind === 'added' ? 'This empty file will be added to the server.' : 'This empty file was deleted on this device.' });
    } else {
        const stats = header.createDiv({ cls: 'crate-diff-stats', attr: { 'aria-label': `${diff.added} added lines, ${diff.removed} removed lines` } });
        stats.createSpan({ text: `+${diff.added}`, cls: 'is-added' });
        stats.createSpan({ text: `−${diff.removed}`, cls: 'is-removed' });
        const code = container.createDiv({ cls: 'crate-diff-code', attr: { tabindex: '0', role: 'region', 'aria-label': `Changes for ${path}` } });
        for (const group of groupDiffContext(diff.lines)) {
            if (!group.hidden) {
                for (const line of group.lines) renderLine(code, line);
                continue;
            }
            const gap = code.createDiv({ cls: 'crate-diff-gap' });
            const expand = gap.createEl('button', { text: `Show ${group.lines.length} unchanged lines`, attr: { type: 'button' } });
            expand.addEventListener('click', () => {
                gap.empty();
                for (const line of group.lines) renderLine(gap, line);
                code.focus({ preventScroll: true });
            });
        }
    }
}

function formatSize(size: number): string {
    return size < 1_000 ? `${size} B` : `${Math.round(size / 1_000)} KB`;
}
