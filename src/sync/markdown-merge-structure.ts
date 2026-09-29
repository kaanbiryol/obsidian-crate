import type { ChangeHunk } from './text-diff';
import { Marked } from 'marked';

// Isolated from renderer extensions/global marked settings. This only tokenizes;
// it never renders HTML or executes code from a note.
const codeParser = new Marked();

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
	return { marker: match?.[1], info: match?.[2] ?? '', quotes, list, indent, containerIndent };
}

/** Conservative code regions, including indented continuations. Ambiguous
 * indentation may require review; it must not authorize a semantic code merge. */
function codeRegions(lines: string[]): Array<{ start: number; end: number }> {
	const regions: Array<{ start: number; end: number }> = [];
	let fence: { start: number; marker: string; length: number; quotes: number; indent: number; ambiguous: boolean } | undefined;
	let indented: number | undefined, lastIndented = 0;
	const flushIndented = () => {
		if (indented !== undefined) regions.push({ start: indented, end: lastIndented + 1 });
		indented = undefined;
	};
	for (const [index, line] of lines.entries()) {
		const clean = index === 0 ? line.replace(/^\uFEFF/u, '') : line;
		const match = fenceLine(clean);
		if (fence) {
			// Leaving a quote/list can end a fence before a later apparent closer.
			// Protect the remainder when its container interpretation is ambiguous.
			fence.ambiguous ||= match.quotes < fence.quotes || match.quotes === fence.quotes && match.indent < fence.indent;
			if (!fence.ambiguous && match.marker && !match.list && match.quotes === fence.quotes && match.indent >= fence.indent && match.indent <= fence.indent + 3
				&& match.marker[0] === fence.marker && match.marker.length >= fence.length && match.info.trim() === '') {
				regions.push({ start: fence.start, end: index + 1 });
				fence = undefined;
			}
		} else if (match.marker) {
			flushIndented();
			fence = { start: index, marker: match.marker[0]!, length: match.marker.length, quotes: match.quotes, indent: match.containerIndent, ambiguous: false };
		} else if (/^(?:[ \t]*> ?)*(?: {4}| {0,3}\t)/u.test(clean) && clean.trim()) {
			indented ??= index;
			lastIndented = index;
		} else if (clean.trim()) flushIndented();
	}
	flushIndented();
	if (fence) regions.push({ start: fence.start, end: lines.length + 1 });
	return regions;
}

/** Existing code is atomic across concurrent edits, including deletions of its
 * boundaries. Identical changes remain idempotent. */
export function hasCompetingCodeEdits(base: string[], local: ChangeHunk[], remote: ChangeHunk[]): boolean {
	const competing = (start: number, end: number) => {
		const touches = (hunk: ChangeHunk) => hunk.start === hunk.end
			? hunk.start > start && hunk.start < end
			: hunk.start < end && hunk.end > start;
		const left = local.filter(touches), right = remote.filter(touches);
		return left.length > 0 && right.length > 0 && JSON.stringify(left) !== JSON.stringify(right);
	};
	return codeRegions(base).some(({ start, end }) => competing(start, end));
}

/** New/moved fences are absent from the ancestor's regions. Validate the output
 * too: every resulting code block must be an intact block authored in an input,
 * never a composition of code or boundaries invented by the prose merger. */
export function preservesAuthoredCode(merged: string[], base: string[], local: string[], remote: string[]): boolean {
	// Standard fenced/indented code requires one of these lexical markers. Avoid
	// tokenizing ordinary prose, including the common repeated-list merge path.
	if (![merged, base, local, remote].some(lines => lines.some(line => /`{3,}|~{3,}| {4}|\t/u.test(line)))) return true;
	const blocks = (lines: string[]) => {
		const result = new Map<string, number>();
		void codeParser.walkTokens(codeParser.lexer(lines.join('\n').replace(/^\uFEFF/u, '')), token => {
			// The lexer includes different final newlines depending on surrounding
			// blocks. Preserve code bytes/language, ignoring only that delimiter.
			if (token.type === 'code') {
				const text: unknown = token.text, language: unknown = token.lang;
				if (typeof text !== 'string' || language !== undefined && typeof language !== 'string') throw new Error('Unreadable code block');
				const key = JSON.stringify([language ?? '', text.replace(/\n+$/u, '')]);
				result.set(key, (result.get(key) ?? 0) + 1);
			}
		});
		return result;
	};
	try {
		const original = blocks(base), left = blocks(local), right = blocks(remote), output = blocks(merged);
		for (const block of output.keys()) if (!original.has(block) && !left.has(block) && !right.has(block)) return false;
		// Another edit can remove a paragraph boundary and turn newly introduced
		// code back into prose without changing its literal lines. Preserve each
		// introduced block as code too, including additional identical copies.
		for (const variant of [left, right]) for (const [block, count] of variant) {
			if (count > (original.get(block) ?? 0) && (output.get(block) ?? 0) < count) return false;
		}
		return true;
	} catch {
		// Pathological nesting or unsupported syntax requires recoverable review.
		return false;
	}
}
