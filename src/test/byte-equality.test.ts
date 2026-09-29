import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

it('compares buffer bytes in ordinary, nested, and containment assertions', () => {
	expect(bytes(1, 2)).toEqual(bytes(1, 2));
	for (const different of [bytes(1, 3), bytes(1), bytes(1, 2, 3), bytes(2, 1)]) {
		expect(() => expect(bytes(1, 2)).toEqual(different)).toThrow();
		expect(() => expect({ copies: [bytes(1, 2)] }).toEqual({ copies: [different] })).toThrow();
		expect(() => expect([bytes(1, 2)]).toContainEqual(different)).toThrow();
	}
	expect(bytes()).not.toEqual({});
});

it('compares buffers from another realm without changing non-buffer equality', () => {
	const foreign: unknown = runInNewContext('new Uint8Array([1, 2]).buffer');
	expect(foreign).toEqual(bytes(1, 2));
	expect(foreign).not.toEqual(bytes(2, 1));
	expect({ value: [1, 2] }).toEqual({ value: [1, 2] });
});
