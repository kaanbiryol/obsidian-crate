import { describe, expect, it } from 'vitest';
import { mergeMarkdownContent } from './markdown-merge';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const merge = (base: string, local: string, remote: string) => mergeMarkdownContent(bytes(base), bytes(local), bytes(remote));

describe('jsdiff merge behavior', () => {
	it.each([
		['- Milk\n- Milk', '- Milk', '- Bread\n- Milk', '- Bread\n- Milk'],
		['- Milk\n- Milk', '- Bread\n- Milk', '- Eggs\n- Milk', '- Bread\n- Eggs\n- Milk'],
		['- Milk\n- Bread\n- Eggs', '- Milk\n- Eggs', '- Milk\n- Bread\n- Cheese', '- Milk\n- Cheese'],
		['- Milk\n- Bread', '', '- Milk\n- Bread', ''],
		['- Milk\n- Bread', '- Milk', '- Milk', '- Milk'],
	])('merges the agreed repeated-line and ordinary deletion cases (%s)', (base, local, remote, expected) => {
		for (const [left, right] of [[local, remote], [remote, local]] as const) {
			const result = merge(base, left, right);
			expect(result.success).toBe(true);
			if (result.success) expect(result.text).toBe(expected);
		}
	});

	it('retains conflict handling when repeated-line edits overlap under jsdiff alignment', () => {
		for (const [local, remote] of [['- Milk\n- Bread', '- Eggs\n- Milk'], ['- Eggs\n- Milk', '- Milk\n- Bread']]) {
			expect(merge('- Milk\n- Milk', local!, remote!)).toEqual({ success: false, reason: 'overlap' });
		}
	});

	it('gives the same decision and bytes after swapping devices, applies identical edits once, and preserves one-sided edits', () => {
		const texts = [''];
		let level: string[][] = [[]];
		for (let length = 1; length <= 3; length++) {
			level = level.flatMap(lines => ['- Milk', '- Bread', '- Eggs'].map(line => [...lines, line]));
			texts.push(...level.map(lines => lines.join('\n')));
		}
		for (const base of texts) for (let i = 0; i < texts.length; i++) for (let j = i; j < texts.length; j++) {
			const local = texts[i]!, remote = texts[j]!;
			const result = merge(base, local, remote);
			expect(result).toEqual(merge(base, remote, local));
			if (local === remote || base === local || base === remote) {
				expect(result.success).toBe(true);
				if (result.success) expect(result.text).toBe(base === local ? remote : local);
			}
		}
	});

	it('falls back to conflict handling when line or inline comparisons exceed the edit budget', () => {
		const lines = (prefix: string) => Array.from({ length: 1_100 }, (_, i) => `${prefix} ${i}`).join('\n');
		expect(merge(lines('base'), lines('local'), lines('remote'))).toEqual({ success: false, reason: 'too-large' });
		expect(merge('a '.repeat(1_100), 'b '.repeat(1_100), 'c '.repeat(1_100))).toEqual({ success: false, reason: 'overlap' });
	});
});
