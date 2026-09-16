import { diffSequence } from '../../sync/text-diff';

export interface DiffLine {
    kind: 'context' | 'added' | 'removed';
    text: string;
    before?: number;
    after?: number;
}

export function buildDiff(before: string, after: string) {
    const left = before === '' ? [] : before.split('\n');
    const right = after === '' ? [] : after.split('\n');
    if (left.length + right.length > 4_000) return { lines: [], added: 0, removed: 0, limited: true };
    const lines: DiffLine[] = [];
    let oldLine = 0, newLine = 0, added = 0, removed = 0;
    const context = (end: number) => {
        while (oldLine < end) {
            lines.push({ kind: 'context', text: left[oldLine]!, before: ++oldLine, after: ++newLine });
        }
    };
    for (const hunk of diffSequence(left, right)) {
        context(hunk.start);
        while (oldLine < hunk.end) {
            lines.push({ kind: 'removed', text: left[oldLine]!, before: ++oldLine });
            removed++;
        }
        for (const text of hunk.replacement) {
            lines.push({ kind: 'added', text, after: ++newLine });
            added++;
        }
    }
    context(left.length);
    return { lines, added, removed, limited: false };
}

/** Keep three unchanged lines beside a change; offer the rest as disclosures. */
export function groupDiffContext(lines: DiffLine[]): Array<{ hidden: boolean; lines: DiffLine[] }> {
    const groups: Array<{ hidden: boolean; lines: DiffLine[] }> = [];
    for (let i = 0; i < lines.length; i++) {
        const hidden = lines[i]!.kind === 'context'
            && !lines.slice(Math.max(0, i - 3), i + 4).some(line => line.kind !== 'context');
        const previous = groups[groups.length - 1];
        if (previous?.hidden === hidden) previous.lines.push(lines[i]!);
        else groups.push({ hidden, lines: [lines[i]!] });
    }
    return groups;
}
