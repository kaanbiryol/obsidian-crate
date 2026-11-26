import { expect, it } from 'vitest';
import { diffOrdered } from './manifest-log';

function apply(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): Map<string, string> {
	const result = new Map(before);
	const changes = diffOrdered(before, after);
	for (const key of changes?.delete ?? []) result.delete(key);
	for (const [key, value] of changes?.set ?? []) result.set(key, value);
	return result;
}

it('replays to the same entries in the same insertion order', () => {
	let seed = 7;
	const random = (limit: number) => { seed = (seed * 48271) % 2147483647; return seed % limit; };
	for (let round = 0; round < 500; round++) {
		const before = new Map(Array.from({ length: random(8) }, (_, index) => [`k${index}`, `v${random(3)}`] as [string, string]));
		const after = new Map(before);
		for (let step = random(6); step > 0; step--) {
			const key = `k${random(10)}`;
			if (random(2)) after.delete(key); else after.set(key, `v${random(3)}`);
		}
		expect([...apply(before, after)]).toEqual([...after]);
	}
});

it('records nothing for equal maps and only changed rows otherwise', () => {
	const before = new Map([['a', '1'], ['b', '2'], ['c', '3']]);
	expect(diffOrdered(before, new Map(before))).toBeNull();
	const after = new Map(before);
	after.set('b', '9');
	after.delete('c');
	expect(diffOrdered(before, after)).toEqual({ delete: ['c'], set: [['b', '9']] });
});
