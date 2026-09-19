import type { PendingDiff } from '../../sync/pending-diff';
import { buildDiff, groupDiffContext, type DiffLine } from './diff-model';

function renderLine(container: HTMLElement, line: DiffLine): void {
    const row = container.createDiv({ cls: `crate-diff-line is-${line.kind}` });
    row.createSpan({ text: line.before?.toString() ?? '', cls: 'crate-diff-number', attr: { 'aria-hidden': 'true' } });
    row.createSpan({ text: line.after?.toString() ?? '', cls: 'crate-diff-number', attr: { 'aria-hidden': 'true' } });
    row.createSpan({ text: line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ', cls: 'crate-diff-sign' });
    const text = row.createEl('code', { cls: 'crate-diff-text' });
    if (line.words) {
        for (const word of line.words) text.createSpan({ text: word.text, cls: word.changed ? 'crate-diff-word' : '' });
    } else text.setText(line.text || ' ');
}

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
        const code = container.createDiv({ cls: 'crate-diff-code', attr: { tabindex: '0', role: 'region', 'aria-label': `Changes for ${path}` } });
        for (const group of groupDiffContext(diff.lines)) {
            if (!group.hidden) {
                for (const line of group.lines) renderLine(code, line);
                continue;
            }
            const gap = code.createDiv({ cls: 'crate-diff-gap' });
            const expand = gap.createEl('button', { text: `··· ${group.lines.length} unchanged lines ···`, attr: { type: 'button', 'aria-label': `Show ${group.lines.length} unchanged lines` } });
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
