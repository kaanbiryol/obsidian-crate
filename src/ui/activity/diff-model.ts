import { diffArrays } from 'diff';

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
    // Bound both the edit search and time spent on the UI thread.
    const changes = diffArrays(left, right, { maxEditLength: 2_000, timeout: 50 });
    if (!changes) return { lines: [], added: 0, removed: 0, limited: true };
    const lines: DiffLine[] = [];
    let oldLine = 0, newLine = 0, added = 0, removed = 0;
    for (const change of changes) {
        for (const text of change.value) {
            if (change.removed) {
                lines.push({ kind: 'removed', text, before: ++oldLine });
                removed++;
            } else if (change.added) {
                lines.push({ kind: 'added', text, after: ++newLine });
                added++;
            } else {
                lines.push({ kind: 'context', text, before: ++oldLine, after: ++newLine });
            }
        }
    }
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
