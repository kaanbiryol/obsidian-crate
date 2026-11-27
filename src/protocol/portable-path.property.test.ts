import { expect, it } from 'vitest';
import fc from 'fast-check';
import { assertPortablePaths, PortablePathSet } from './portable-path';

const outcome = (check: () => void): string | null => {
	try { check(); return null; } catch (error) { return (error as Error).message; }
};

// Few names, with case, Unicode and nesting variants, so snapshots often collide.
const segment = fc.constantFrom('a', 'A', 'b', 'café', 'café', 'a.md', 'A.md', 'x', 'CON', 'trail.');
const path = fc.array(segment, { minLength: 1, maxLength: 3 }).map(parts => parts.join('/'));

it('accepts and rejects each snapshot of a sequence exactly as a full check does', () => {
	fc.assert(fc.property(fc.array(fc.array(path, { maxLength: 6 }), { minLength: 1, maxLength: 8 }), snapshots => {
		const set = new PortablePathSet();
		for (const snapshot of snapshots) expect(outcome(() => set.assert(snapshot))).toBe(outcome(() => assertPortablePaths(snapshot)));
	}), { numRuns: 2000 });
});
