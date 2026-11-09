import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { loadReading, queryReadingItems } from './api';
import { removeEarlierReadingCopies } from './storage/storage';
import { type ReadingSession } from './session/session';

vi.mock('./session/encryption-session', () => ({
	prepareReadingEncryption: async () => null,
	readingEncryptionHeaders: () => ({}),
	readingEncryptionKeys: () => null,
	readingNoteFolder: ({ folderPath }: { folderPath: string }) => folderPath,
}));
vi.mock('./session/session', async importOriginal => ({ ...await importOriginal<typeof import('./session/session')>(), assertReadingSession: vi.fn() }));
vi.mock('./storage/storage', () => ({
	removeEarlierReadingCopies: vi.fn(async () => {}),
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
	expect(removeEarlierReadingCopies).not.toHaveBeenCalled();
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
