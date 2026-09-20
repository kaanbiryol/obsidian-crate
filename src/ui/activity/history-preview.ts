import type { HistoryRestorePreview } from '../../sync/history-restore-preview';
import { buildDiff } from './diff-model';
import { renderDiffLines } from './diff-renderer';
import { renderFileText } from './history-text';

/** Saved-state display for browsing vault history. */
export function renderHistoryPreview(output: HTMLElement, snapshot: HistoryRestorePreview, counts: HTMLElement, label: string, compared = true): void {
    output.empty();
    const message = (text: string) => output.createEl('p', { text, cls: 'crate-history-description', attr: { role: 'status' } });
    if ('unavailable' in snapshot) { message(snapshot.unavailable); return; }
    if (!compared) {
        renderFileText(output.createEl('pre', { attr: { tabindex: '0', 'aria-label': 'Saved file contents' } }), snapshot.saved || '(Empty file)');
        return;
    }
    const diff = buildDiff(snapshot.current, snapshot.saved);
    if (diff.limited) { message('This change is too large to display.'); return; }
    if (!diff.added && !diff.removed) { message('No text differences.'); return; }
    counts.createSpan({ text: `+${diff.added}`, cls: 'is-added', attr: { 'aria-label': `${diff.added} added lines` } });
    counts.createSpan({ text: `−${diff.removed}`, cls: 'is-removed', attr: { 'aria-label': `${diff.removed} removed lines` } });
    renderDiffLines(output, diff.lines, label, (el, line) => renderFileText(el, line.text || ' ', line.words));
}
