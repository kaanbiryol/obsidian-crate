import { expect, it, vi } from 'vitest';
import { createEncryptedInventoryProgress, encryptedInventoryPages, parseEncryptedInventoryPage, type EncryptedInventoryPage, ENCRYPTED_INVENTORY_PAGE } from './file-inventory';

const file = (path = 'Reading/Article.md') => ({ path, hash: 'a'.repeat(64), size: 12, revision: 'revision' });
const page = (patch: Partial<EncryptedInventoryPage> = {}): EncryptedInventoryPage => ({ files: [], sequence: 1, generation: 1, nextCursor: null, ...patch });

it.each([
	null, [], {}, page({ sequence: -1 }), page({ sequence: 1.5 }), page({ generation: 2 }),
	{ ...page(), files: null }, { ...page(), files: [null] }, page({ files: Array.from({ length: ENCRYPTED_INVENTORY_PAGE + 1 }, () => file()) }),
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

const changed = () => new Error('changed while loading');
async function collect(pages: AsyncIterable<EncryptedInventoryPage>, onPage = (_page: EncryptedInventoryPage) => {}) {
	const seen: Array<string | null> = [];
	for await (const value of pages) { seen.push(value.nextCursor); onPage(value); }
	return seen;
}

it('pages from a supplied first page through each cursor at one sequence', async () => {
	const fetchPage = vi.fn(async (after?: string) => after === 'A' ? page({ files: [file('Reading/2.md')], nextCursor: 'B' }) : page({ files: [file('Reading/3.md')] }));
	const pages = encryptedInventoryPages(fetchPage, { maxFiles: 3, first: page({ files: [file('Reading/1.md')], nextCursor: 'A' }), changed });
	expect(await collect(pages)).toEqual(['A', 'B', null]);
	// The supplied first page is not fetched again, and nothing confirms by default.
	expect(fetchPage.mock.calls).toEqual([['A'], ['B']]);
});

it('fetches the first page when none is supplied', async () => {
	const fetchPage = vi.fn(async () => page());
	expect(await collect(encryptedInventoryPages(fetchPage, { maxFiles: 1, changed }))).toEqual([null]);
	expect(fetchPage.mock.calls).toEqual([[]]);
});

it('throws the caller error when a later page reports another sequence', async () => {
	const pages = encryptedInventoryPages(async () => page({ sequence: 2 }), { maxFiles: 1, first: page({ nextCursor: 'A' }), changed });
	await expect(collect(pages)).rejects.toThrow('changed while loading');
});

it('checks device limits before yielding a page', async () => {
	const pages = encryptedInventoryPages(async () => page({ files: [file('Reading/2.md')] }), { maxFiles: 1, first: page({ files: [file('Reading/1.md')], nextCursor: 'A' }), changed });
	const handled: Array<string | null> = [];
	await expect(collect(pages, value => handled.push(value.nextCursor))).rejects.toThrow('limit');
	expect(handled).toEqual(['A']);
});

it.each([[1, null], [2, 'changed while loading']])('confirms sequence %i after the caller handles the last page', async (confirmedSequence, error) => {
	const events: string[] = [];
	const fetchPage = vi.fn(async (after?: string) => {
		events.push(`fetch ${after ?? 'first'}`);
		return after ? page() : page({ sequence: confirmedSequence });
	});
	const pages = encryptedInventoryPages(fetchPage, { maxFiles: 1, first: page({ nextCursor: 'A' }), confirm: true, changed });
	const result = collect(pages, value => events.push(`handled ${value.nextCursor ?? 'last'}`));
	if (error) await expect(result).rejects.toThrow(error);
	else await expect(result).resolves.toEqual(['A', null]);
	expect(events).toEqual(['handled A', 'fetch A', 'handled last', 'fetch first']);
});
