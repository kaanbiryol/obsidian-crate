import { describe, expect, it } from 'vitest';
import { stableJson } from './stable-json';

describe('stableJson', () => {
	it('ignores object key order at every depth', () => {
		expect(stableJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(stableJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }));
	});

	it('keeps array order and distinguishes changed values', () => {
		expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
		expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
		expect(stableJson(null)).toBe('null');
	});
});
