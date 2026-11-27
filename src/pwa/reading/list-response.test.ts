import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { loadReading, queryReadingItems, queryReadingTags, reloadReadingAfterWrites, takeCommittedReadingArticle } from './api';
import { sha256Hex } from '@/platform/sha256';
import { removeEarlierSessionCopies } from './storage/storage';
import { type ReadingSession } from './session/session';

vi.mock('./session/encryption-session', () => ({
	prepareReadingEncryption: async () => null,
	readingEncryptionHeaders: () => ({}),
	readingEncryptionKeys: () => null,
	readingNoteFolder: ({ folderPath }: { folderPath: string }) => folderPath,
}));
vi.mock('./session/session', async importOriginal => ({ ...await importOriginal<typeof import('./session/session')>(), assertReadingSession: vi.fn() }));
vi.mock('./storage/storage', () => ({
	removeEarlierSessionCopies: vi.fn(async () => {}),
}));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const network = vi.fn<typeof fetch>();
const issue = { path: 'Reading/Damaged.md', message: 'Source could not be read.' };
function item(index: number, path = `Reading/${index}.md`): ReadingItem {
	return {
		crate_reading_version: 1, crate_reading_id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
		title: `Article ${index}`, source_url: `https://example.com/${index}`, saved_at: '2026-10-01T12:00:00.000Z',
		reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', path,
	};
}
function respond(...pages: unknown[]) {
	for (const page of pages) network.mockResolvedValueOnce(Response.json(page));
}
beforeEach(() => {
	vi.clearAllMocks(); network.mockReset();
	network.mockImplementation(async () => { throw new Error('Unexpected extra list request'); });
	vi.stubGlobal('fetch', network);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
	null, [], {},
	{ items: [], issues: [] },
	...[{}, [], 42, false, '', 'x'.repeat(4097)].map(cursor => ({ items: [], issues: [], cursor })),
	{ items: {}, issues: [], cursor: null },
	{ items: [], issues: {}, cursor: null },
	{ items: [null], issues: [], cursor: null },
	{ items: [{ ...item(1), path: 42 }], issues: [], cursor: null },
	{ items: [item(1, 'Other/Article.md')], issues: [], cursor: null },
	{ items: [], issues: [{ path: issue.path, message: 42 }], cursor: null },
])('rejects a malformed page before following its cursor or committing: %#', async page => {
	respond(page);
	await expect(loadReading(session)).rejects.toThrow('Reading library response is unreadable.');
	expect(network).toHaveBeenCalledOnce();
	expect(removeEarlierSessionCopies).not.toHaveBeenCalled();
});

it('saves the first inbox page and its issues, and rejects repeated Reading IDs', async () => {
	respond({ items: [item(2), item(1)], issues: [issue], cursor: '["2026","reading/1.md"]' });
	await expect(loadReading(session)).resolves.toMatchObject({ items: [item(2), item(1)], issues: [issue] });
	expect(network.mock.calls[0]![0]).toBe('/reading/items?section=inbox');
	respond({ items: [item(1), item(1)], issues: [], cursor: null });
	await expect(loadReading(session)).rejects.toThrow('Reading library response is unreadable.');
});

it('asks the server for one page of a section, search and tag', async () => {
	respond({ items: [item(1)], issues: [], cursor: null });
	await expect(queryReadingItems(session, { section: 'archived', q: 'java mem', tag: 'Code', cursor: 'next' })).resolves.toEqual({ items: [item(1)], issues: [], cursor: null });
	expect(network.mock.calls[0]![0]).toBe('/reading/items?section=archived&q=java+mem&tag=Code&cursor=next');
});

it('ranks tied server tags by name, as a local library does', async () => {
	respond({ tags: ['zebra', 'apple', 'mango', 'kiwi'], counts: [2, 2, 5, 2] });
	await expect(queryReadingTags(session, 'inbox')).resolves.toEqual([
		{ name: 'mango', count: 5 }, { name: 'apple', count: 2 }, { name: 'kiwi', count: 2 }, { name: 'zebra', count: 2 },
	]);
});

it('asks only what changed after the first read, and reads the first page again on reset', async () => {
	const own = { ...session, id: 'changes' };
	respond({ items: [item(1), item(2)], issues: [], cursor: null, revision: '0.5' });
	const first = await loadReading(own);
	expect(first.revision).toBe('0.5');
	// Unchanged: the same library, from one small request.
	respond({ revision: '0.5', items: [], issues: [], removed: [] });
	expect(await loadReading(own)).toBe(first);
	expect(network.mock.calls.at(-1)![0]).toBe('/reading/changes?since=0.5');
	respond({ revision: '0.7', items: [{ ...item(2), title: 'Renamed' }], issues: [issue], removed: ['Reading/1.md'] });
	const changed = await loadReading(own);
	expect(changed).toMatchObject({ revision: '0.7', items: [{ title: 'Renamed' }], issues: [issue], changes: { from: '0.5', to: '0.7' } });
	expect(removeEarlierSessionCopies).toHaveBeenCalledTimes(1);
	respond({ revision: '1.7', reset: true }, { items: [item(3)], issues: [], cursor: null, revision: '1.7' });
	expect(await loadReading(own)).toMatchObject({ revision: '1.7', items: [{ title: 'Article 3' }] });
	expect(network.mock.calls.at(-1)![0]).toBe('/reading/items?section=inbox');
});

it('keeps a committed body for the open reader once, and only when it matches its hash', async () => {
	const own = { ...session, id: 'committed-session' }, edited = { ...item(1), favorite: true };
	const markdown = '==Article== text.', markdownHash = await sha256Hex(markdown);
	respond({ items: [edited], issues: [], cursor: null });
	await reloadReadingAfterWrites(own, [{ itemId: edited.crate_reading_id, article: { item: edited, etag: '"new"', markdownHash, markdown } }]);
	expect(takeCommittedReadingArticle({ ...own, generation: 'other' }, edited.crate_reading_id)).toBeUndefined();
	respond({ items: [edited], issues: [], cursor: null });
	await reloadReadingAfterWrites(own, [{ itemId: edited.crate_reading_id, article: { item: edited, etag: '"new"', markdownHash, markdown } }]);
	expect(takeCommittedReadingArticle(own, edited.crate_reading_id)).toEqual({ item: edited, etag: '"new"', markdownHash, markdown });
	expect(takeCommittedReadingArticle(own, edited.crate_reading_id)).toBeUndefined();

	respond({ items: [edited], issues: [], cursor: null });
	await reloadReadingAfterWrites(own, [{ itemId: edited.crate_reading_id, article: { item: edited, etag: '"new"', markdownHash, markdown: 'Tampered.' } }]);
	expect(takeCommittedReadingArticle(own, edited.crate_reading_id)).toEqual({ item: edited, etag: '"new"', markdownHash });
});
