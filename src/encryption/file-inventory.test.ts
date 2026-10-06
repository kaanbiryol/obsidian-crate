import { expect, it } from 'vitest';
import { createEncryptedInventoryProgress, parseEncryptedInventoryPage, type EncryptedInventoryPage } from './file-inventory';

const file = (path = 'Reading/Article.md') => ({ path, hash: 'a'.repeat(64), size: 12, revision: 'revision' });
const page = (patch: Partial<EncryptedInventoryPage> = {}): EncryptedInventoryPage => ({ files: [], sequence: 1, generation: 1, nextCursor: null, ...patch });

it.each([
	null, [], {}, page({ sequence: -1 }), page({ sequence: 1.5 }), page({ generation: 2 }),
	{ ...page(), files: null }, { ...page(), files: [null] }, page({ files: Array.from({ length: 101 }, () => file()) }),
	...[false, 5, '', 'x'.repeat(4097)].map(nextCursor => ({ ...page(), nextCursor })),
	...['Elsewhere/Article.md', 'Reading//Article.md', 'Reading/../Article.md', 'Reading/./Article.md', 'Reading/Bad\\Path.md'].map(path => page({ files: [file(path)] })),
	...[-1, 1.5, '12'].map(size => ({ ...page(), files: [{ ...file(), size }] })),
	page({ files: [{ ...file(), hash: 'bad' }] }), page({ files: [{ ...file(), revision: '' }] }),
])('rejects malformed or out-of-scope wire pages: %#', value => {
	expect(() => parseEncryptedInventoryPage(value, 'Reading', 1)).toThrow('Invalid encrypted file');
});

it('accepts the terminal page at the exact file and page limits', () => {
	const accept = createEncryptedInventoryProgress({ maxFiles: 2, maxPages: 3 });
	accept(page({ files: [file('Reading/1.md')], nextCursor: '1' }));
	accept(page({ nextCursor: '2' }));
	expect(() => accept(page({ files: [file('Reading/2.md')] }))).not.toThrow();
});

it('rejects cumulative overflow on a terminal page', () => {
	const accept = createEncryptedInventoryProgress({ maxFiles: 1, maxPages: 3 });
	accept(page({ files: [file('Reading/1.md')], nextCursor: '1' }));
	expect(() => accept(page({ files: [file('Reading/2.md')] }))).toThrow('limit');
});

it('stops empty advancing pages before requesting beyond the budget', () => {
	const accept = createEncryptedInventoryProgress({ maxFiles: 1, maxPages: 2 });
	accept(page({ nextCursor: '1' }));
	expect(() => accept(page({ nextCursor: '2' }))).toThrow('limit');
});

it.each([['A', 'A'], ['A', 'B', 'A']])('rejects cursor repetition or regression: %j', (...cursors) => {
	const accept = createEncryptedInventoryProgress({ maxFiles: 1, maxPages: 10 });
	for (const nextCursor of cursors.slice(0, -1)) accept(page({ nextCursor }));
	expect(() => accept(page({ nextCursor: cursors.at(-1)! }))).toThrow('did not advance');
});

it.each([false, true])('rejects repeated paths within or across pages: %j', acrossPages => {
	const accept = createEncryptedInventoryProgress({ maxFiles: 10, maxPages: 10 });
	if (acrossPages) accept(page({ files: [file()], nextCursor: 'A' }));
	expect(() => accept(page({ files: acrossPages ? [file()] : [file(), file()] }))).toThrow('repeated a file');
});
