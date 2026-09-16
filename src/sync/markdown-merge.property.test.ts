import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mergeMarkdownContent } from './markdown-merge';
import { diffSequence } from './text-diff';

const token = fc.oneof(fc.constantFrom('', ' ', '- Milk', '- Milk', 'Café ☕', '👩🏽‍💻', 'e\u0301', '\t', '---', '```'),
	fc.string({ unit: 'grapheme', maxLength: 40 }));
const sequence = fc.array(token, { maxLength: 100 });
const line = token.map(value => value.replace(/[\r\n]/g, ' '));
const lines = fc.array(line, { maxLength: 60 });
const edit = fc.record({ at: fc.nat(), remove: fc.nat({ max: 8 }), insert: fc.array(line, { maxLength: 8 }) });
const edits = fc.array(edit, { maxLength: 10 });
function applyEdits(base: string[], changes: { at: number; remove: number; insert: string[] }[]): string[] {
	const result = [...base];
	for (const change of changes) result.splice(change.at % (result.length + 1), change.remove, ...change.insert);
	return result;
}
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const merge = (base: string, local: string, remote: string) => mergeMarkdownContent(bytes(base), bytes(local), bytes(remote));

// fast-check prints a seed and shrink path on failure for exact replay. Keep the
// exhaustive short-input tests too; these explore larger, Unicode-heavy inputs.
describe('generated diff and merge invariants', () => {
	it('reconstructs the exact target without changing either input', () => {
		fc.assert(fc.property(sequence, sequence, (base, target) => {
			const before = structuredClone({ base, target });
			const hunks = diffSequence(base, target);
			expect(hunks).not.toBeNull();
			const result: string[] = [];
			let cursor = 0;
			for (const hunk of hunks!) {
				expect(hunk.start).toBeGreaterThanOrEqual(cursor);
				expect(hunk.end).toBeGreaterThanOrEqual(hunk.start);
				expect(hunk.end).toBeLessThanOrEqual(base.length);
				result.push(...base.slice(cursor, hunk.start), ...hunk.replacement);
				cursor = hunk.end;
			}
			result.push(...base.slice(cursor));
			expect(result).toEqual(target);
			expect({ base, target }).toEqual(before);
		}), { numRuns: 1_000 });
	});

	it('makes the same decision and produces the same bytes when devices are swapped', () => {
		fc.assert(fc.property(lines, edits, edits, fc.constantFrom('\n', '\r\n'), fc.boolean(), (base, left, right, eol, finalNewline) => {
			const text = (value: string[]) => value.join(eol) + (finalNewline ? eol : '');
			const original = text(base), local = text(applyEdits(base, left)), remote = text(applyEdits(base, right));
			expect(merge(original, local, remote)).toEqual(merge(original, remote, local));
		}), { numRuns: 1_000 });
	});

	it('preserves one-sided edits and applies identical edits once, using the base line endings', () => {
		fc.assert(fc.property(lines, edits, fc.constantFrom('\n', '\r\n'), (base, changes, eol) => {
			// A final newline makes blank trailing lines unambiguous. An empty
			// document is represented by one empty line plus its newline here.
			const text = (value: string[]) => value.join(eol) + eol;
			const original = text(base), edited = text(applyEdits(base, changes));
			for (const [local, remote] of [[original, edited], [edited, original], [edited, edited]]) {
				const result = merge(original, local!, remote!);
				expect(result.success).toBe(true);
				if (result.success) {
					expect(result.text).toBe(edited);
					expect(result.content).toEqual(bytes(edited));
				}
			}
		}), { numRuns: 1_000 });
	});
});
