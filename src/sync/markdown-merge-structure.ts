import type { ChangeHunk } from './text-diff';

/** Frontmatter is an atomic field: combining valid YAML edits can invent invalid
 * mappings (or valid YAML with unintended values). Preserve one authored header.
 */
export function frontmatter(lines: string[]): string {
	if (lines[0]?.trim() !== '---') return '';
	const close = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
	return lines.slice(0, close < 0 ? lines.length : close + 1).join('\n');
}

/** Concurrent changes to a code fence are conflicts, including insertions on
 * different lines. The fence may contain JSON/YAML/code whose invariants cannot
 * be inferred by a prose merger. Identical edits remain idempotent.
 */
export function hasCompetingFenceEdits(base: string[], local: ChangeHunk[], remote: ChangeHunk[]): boolean {
	let fence: { start: number; marker: string; length: number } | undefined;
	const competing = (start: number, end: number) => {
		const touches = (hunk: ChangeHunk) => hunk.start === hunk.end
			? hunk.start > start && hunk.start < end
			: hunk.start < end && hunk.end > start;
		const left = local.filter(touches), right = remote.filter(touches);
		return left.length > 0 && right.length > 0 && JSON.stringify(left) !== JSON.stringify(right);
	};
	for (const [index, line] of base.entries()) {
		const match = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
		if (!match) continue;
		const marker = match[1]!;
		if (!fence) fence = { start: index, marker: marker[0]!, length: marker.length };
		else if (marker[0] === fence.marker && marker.length >= fence.length && match[2]!.trim() === '') {
			if (competing(fence.start, index + 1)) return true;
			fence = undefined;
		}
	}
	return !!fence && competing(fence.start, base.length + 1);
}
