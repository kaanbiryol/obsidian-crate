import { expect, it } from 'vitest';
import { assignPlainPaths } from './sync';

it('keeps distinct names and their server order', () => {
	expect(assignPlainPaths([{ path: 'a.md', wire: 'w/1' }, { path: 'b.md', wire: 'w/2' }], [false, true]))
		.toEqual([{ index: 1, path: 'b.md' }, { index: 0, path: 'a.md' }]);
});

it('lets the file at its name’s own tag keep a name two server files claim', () => {
	const entries = [
		{ path: 'Notes/Plan.md', wire: 'e/0123456789abcdef.md' },
		{ path: 'Notes/Plan.md', wire: 'e/fedcba9876543210.md' },
	];
	expect(assignPlainPaths(entries, [false, true])).toEqual([
		{ index: 1, path: 'Notes/Plan.md' },
		{ index: 0, path: 'Notes/Plan - 01234567.md' },
	]);
});

it('treats names differing only in case or normalization as one claim', () => {
	const entries = [{ path: 'Café.md', wire: 'e/aaaaaaaa1' }, { path: 'café.MD', wire: 'e/bbbbbbbb2' }];
	expect(assignPlainPaths(entries, [true, false]).map(item => item.path)).toEqual(['Café.md', 'café - bbbbbbbb.MD']);
});

it('adds the suffix at the end of names without an extension', () => {
	const entries = [{ path: 'v1.2/README', wire: 'e/11111111x' }, { path: 'v1.2/README', wire: 'e/22222222y' }];
	expect(assignPlainPaths(entries, [true, false]).map(item => item.path)).toEqual(['v1.2/README', 'v1.2/README - 22222222']);
});
