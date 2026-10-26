import { describe, expect, it } from 'vitest';
import { buildConflictDiff } from './conflict-diff';

describe('conflict comparison', () => {
	it('aligns insertions without giving the empty side a line number', () => {
		const { rows } = buildConflictDiff('one\nthree', 'one\ntwo\nthree');
		expect(rows[1]).toEqual({ current: undefined, saved: { number: 2, text: 'two', changed: true } });
		expect(rows[2]?.current).toMatchObject({ number: 2, text: 'three', changed: false });
		expect(rows[2]?.saved).toMatchObject({ number: 3, text: 'three', changed: false });
	});
	it('aligns deletions and keeps following context paired', () => {
		const { rows } = buildConflictDiff('one\ntwo\nthree', 'one\nthree');
		expect(rows[1]?.saved).toBeUndefined();
		expect(rows[1]?.current).toMatchObject({ text: 'two', changed: true });
		expect(rows[2]?.saved).toMatchObject({ number: 2, text: 'three' });
	});
	it('highlights changed words while preserving every character', () => {
		const { rows } = buildConflictDiff('Lunch at 13:00', 'Lunch at 12:00');
		for (const side of ['current', 'saved'] as const) {
			const line = rows[0]![side]!;
			expect(line.words!.map(word => word.text).join('')).toBe(line.text);
			expect(line.words!.filter(word => word.changed).map(word => word.text).join('')).toBe(side === 'current' ? '13' : '12');
		}
	});
	it('pads unequal replacement blocks and preserves trailing blank lines', () => {
		const { rows } = buildConflictDiff('a\nb\nc\nz\n', 'a\nx\nz\n');
		expect(rows[2]?.saved).toBeUndefined();
		expect(rows[3]?.current?.text).toBe('z');
		expect(rows[3]?.saved?.text).toBe('z');
		expect(rows[4]?.saved?.text).toBe('');
	});
});

it('bounds total highlighting time for large conflicts', () => {
	let seed = 7;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const current = Array.from({ length: 200 }, () => Array.from({ length: 600 }, () => `w${Math.floor(random() * 50)}`).join(' '));
	const saved = current.map(line => line.split(' ').map(word => random() < 0.3 ? `x${Math.floor(random() * 50)}` : word).join(' '));
	const started = performance.now();
	const { rows, limited } = buildConflictDiff(current.join('\n'), saved.join('\n'));
	// Before: about 1.9 seconds for this 455 KB file on an M-series Mac.
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(limited).toBe(false);
	expect(rows).toHaveLength(200);
	expect(rows.every(row => row.current?.changed && row.saved?.changed)).toBe(true);
});
