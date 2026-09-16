import { describe, expect, it } from 'vitest';
import { diffSequence } from './text-diff';

describe('jsdiff hunk adapter', () => {
	it('combines adjacent removals and additions into a base-relative replacement', () => {
		expect(diffSequence(['a', 'b', 'c'], ['a', 'x', 'y', 'c'])).toEqual([
			{ start: 1, end: 2, replacement: ['x', 'y'] },
		]);
	});

	it('reconstructs exact targets including empty tokens, repeats and Unicode', () => {
		const sequences: string[][] = [[]];
		let level: string[][] = [[]];
		for (let length = 1; length <= 3; length++) {
			level = level.flatMap(tokens => ['', ' ', 'Café ☕'].map(token => [...tokens, token]));
			sequences.push(...level);
		}
		for (const base of sequences) for (const target of sequences) {
			const hunks = diffSequence(base, target);
			expect(hunks).not.toBeNull();
			const result: string[] = [];
			let cursor = 0;
			for (const hunk of hunks!) {
				expect(hunk.start).toBeGreaterThanOrEqual(cursor);
				expect(hunk.end).toBeGreaterThanOrEqual(hunk.start);
				result.push(...base.slice(cursor, hunk.start), ...hunk.replacement);
				cursor = hunk.end;
			}
			result.push(...base.slice(cursor));
			expect(result).toEqual(target);
		}
	});

	it('returns no partial hunks when the edit search exceeds its budget', () => {
		const before = Array.from({ length: 1_100 }, (_, i) => `before ${i}`);
		const after = Array.from({ length: 1_100 }, (_, i) => `after ${i}`);
		expect(diffSequence(before, after)).toBeNull();
	});
});
