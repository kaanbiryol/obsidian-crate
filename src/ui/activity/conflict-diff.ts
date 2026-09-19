import { diffWordsWithSpace } from 'diff';
import { diffSequence } from '../../sync/text-diff';

export interface ConflictDiffLine {
    number: number;
    text: string;
    changed: boolean;
    words?: Array<{ text: string; changed: boolean }>;
}
export interface ConflictDiffRow { current?: ConflictDiffLine; saved?: ConflictDiffLine }

/** Pair replacements and reserve empty rows for additions/deletions. */
export function buildConflictDiff(current: string, saved: string): { rows: ConflictDiffRow[]; limited: boolean } {
    const left = current.split('\n'), right = saved.split('\n');
    const hunks = diffSequence(left, right);
    const rows: ConflictDiffRow[] = [];
    let l = 0, r = 0;
    const append = (leftCount: number, rightCount: number, changed: boolean) => {
        for (let i = 0; i < Math.max(leftCount, rightCount); i++) {
            const a: ConflictDiffLine | undefined = i < leftCount ? { number: l + 1, text: left[l++]!, changed } : undefined;
            const b: ConflictDiffLine | undefined = i < rightCount ? { number: r + 1, text: right[r++]!, changed } : undefined;
            if (changed && a && b && a.text.length + b.text.length <= 10_000) {
                const words = diffWordsWithSpace(a.text, b.text, { maxEditLength: 500, timeout: 20 });
                if (words) {
                    a.words = words.filter(word => !word.added).map(word => ({ text: word.value, changed: !!word.removed }));
                    b.words = words.filter(word => !word.removed).map(word => ({ text: word.value, changed: !!word.added }));
                }
            }
            rows.push({ current: a, saved: b });
        }
    };
    if (!hunks) {
        append(left.length, right.length, false);
        return { rows, limited: true };
    }
    for (const hunk of hunks) {
        const unchanged = hunk.start - l;
        append(unchanged, unchanged, false);
        append(hunk.end - hunk.start, hunk.replacement.length, true);
    }
    append(left.length - l, right.length - r, false);
    return { rows, limited: false };
}

export function renderConflictDiffLine(parent: HTMLElement, line: ConflictDiffLine | undefined, side: 'current' | 'saved'): void {
    const kind = !line ? 'empty' : line.changed ? side === 'current' ? 'removed' : 'added' : 'unchanged';
    const row = parent.createDiv({ cls: `crate-conflict-line is-${kind}` });
    row.createSpan({ text: line?.number.toString() ?? '', cls: 'crate-conflict-line-number', attr: { 'aria-hidden': 'true' } });
    row.createSpan({ text: line?.changed ? side === 'current' ? '−' : '+' : ' ', cls: 'crate-conflict-line-sign' });
    const text = row.createSpan({ cls: 'crate-conflict-line-text' });
    if (line?.words) {
        for (const word of line.words) text.createSpan({ text: word.text, cls: word.changed ? 'crate-conflict-word' : '' });
    } else text.setText(line?.text || ' ');
}
