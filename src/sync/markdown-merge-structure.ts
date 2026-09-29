import type { ChangeHunk } from './text-diff';

/** Frontmatter is an atomic field: combining valid YAML edits can invent invalid
 * mappings (or valid YAML with unintended values). Preserve one authored header.
 */
export function frontmatter(lines: string[]): string {
	if (lines[0]?.trim() !== '---') return '';
	const close = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
	return lines.slice(0, close < 0 ? lines.length : close + 1).join('\n');
}

/** Recognize fences behind nested quote/list markers without parsing their
 * contents as prose. Closing fences may use continuation indentation, but must
 * not strip additional quote or list markers from literal code inside a fence.
 */
function fenceLine(line: string) {
	let rest = line, quotes = 0, list = false, indent = 0, containerIndent = 0;
	while (rest) {
		const space = /^[ \t]*/u.exec(rest)![0];
		for (const char of space) indent += char === '\t' ? 4 - indent % 4 : 1;
		rest = rest.slice(space.length);
		const quote = /^> ?/u.exec(rest);
		if (quote) {
			quotes++;
			indent = containerIndent = 0;
			rest = rest.slice(quote[0].length);
			continue;
		}
		const item = /^(?:[-+*]|\d{1,9}[.)])(?=[ \t])/u.exec(rest);
		if (!item) break;
		list = true;
		indent += item[0].length;
		rest = rest.slice(item[0].length);
		const padding = /^[ \t]+/u.exec(rest)![0];
		for (const char of padding) indent += char === '\t' ? 4 - indent % 4 : 1;
		containerIndent = indent;
		rest = rest.slice(padding.length);
	}
	const match = /^(`{3,}|~{3,})(.*)$/u.exec(rest);
	return match ? { marker: match[1]!, info: match[2]!, quotes, list, indent, containerIndent } : null;
}

/** Concurrent changes to a code fence are conflicts, including insertions on
 * different lines. The fence may contain JSON/YAML/code whose invariants cannot
 * be inferred by a prose merger. Identical edits remain idempotent.
 */
export function hasCompetingFenceEdits(base: string[], local: ChangeHunk[], remote: ChangeHunk[]): boolean {
	let fence: { start: number; marker: string; length: number; quotes: number; indent: number } | undefined;
	const competing = (start: number, end: number) => {
		const touches = (hunk: ChangeHunk) => hunk.start === hunk.end
			? hunk.start > start && hunk.start < end
			: hunk.start < end && hunk.end > start;
		const left = local.filter(touches), right = remote.filter(touches);
		return left.length > 0 && right.length > 0 && JSON.stringify(left) !== JSON.stringify(right);
	};
	for (const [index, line] of base.entries()) {
		const match = fenceLine(index === 0 ? line.replace(/^\uFEFF/u, '') : line);
		if (!match) continue;
		const { marker } = match;
		if (!fence) fence = { start: index, marker: marker[0]!, length: marker.length, quotes: match.quotes, indent: match.containerIndent };
		else if (!match.list && match.quotes === fence.quotes && match.indent >= fence.indent && match.indent <= fence.indent + 3
			&& marker[0] === fence.marker && marker.length >= fence.length && match.info.trim() === '') {
			if (competing(fence.start, index + 1)) return true;
			fence = undefined;
		}
	}
	return !!fence && competing(fence.start, base.length + 1);
}
