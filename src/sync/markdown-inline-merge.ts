import { diffSequence, type ChangeHunk } from './text-diff';
import { mergeSequences } from './text-merge';

const MAX_INLINE_CHARACTERS = 16_000;
const MAX_DOCUMENT_INLINE_CHARACTERS = 128_000;

// Keep whitespace-delimited words intact, including punctuation, numbers and
// emoji sequences. Merging parts of a competing word/number replacement can
// silently invent a value neither device wrote. Whitespace is preserved.
function tokenize(text: string): string[] {
	return text.match(/\s+|\S+/gu) ?? [];
}

function isParagraph(line: string): boolean {
	return line.trim().length > 0
		&& !/^(?: {4}|\t|\s*(?:[#>\-+*`~|<]|\d+[.)]\s|\[))/u.test(line);
}

function paragraphLines(lines: string[]): Set<number> {
	const eligible = new Set<number>();
	let frontmatter = lines[0]?.replace(/^\uFEFF/u, '') === '---';
	let fence: { marker: string; length: number } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (frontmatter) {
			if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line)) frontmatter = false;
			continue;
		}
		const marker = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence) {
			if (marker && marker[1]![0] === fence.marker
				&& marker[1]!.length >= fence.length && marker[2]!.trim() === '') {
				fence = undefined;
			}
			continue;
		}
		if (marker) {
			fence = { marker: marker[1]![0]!, length: marker[1]!.length };
			continue;
		}
		if (isParagraph(line)) eligible.add(index);
	}
	return eligible;
}

export function createInlineMerger(baseLines: string[]): (local: ChangeHunk, remote: ChangeHunk) => string[] | null {
	const eligible = paragraphLines(baseLines);
	let remainingCharacters = MAX_DOCUMENT_INLINE_CHARACTERS;
	return (local, remote) => {
		const count = local.end - local.start;
		// Only refine aligned replacements. Line insertions/deletions and changes
		// to Markdown structure retain the original line-level conflict policy.
		if (count !== local.replacement.length || count !== remote.replacement.length) return null;
		const merged: string[] = [];
		for (let offset = 0; offset < count; offset++) {
			const index = local.start + offset;
			const base = baseLines[index]!;
			const left = local.replacement[offset]!;
			const right = remote.replacement[offset]!;
			if (left === right || right === base) {
				merged.push(left);
				continue;
			}
			if (left === base) {
				merged.push(right);
				continue;
			}
			const characters = base.length + left.length + right.length;
			if (!eligible.has(index) || !isParagraph(left) || !isParagraph(right)
				|| characters > MAX_INLINE_CHARACTERS || characters > remainingCharacters) return null;
			remainingCharacters -= characters;
			const tokens = tokenize(base);
			const result = mergeSequences(tokens, diffSequence(tokens, tokenize(left)), diffSequence(tokens, tokenize(right)), {
				combineInsertions: false,
			});
			if (!result) return null;
			merged.push(result.join(''));
		}
		return merged;
	};
}
