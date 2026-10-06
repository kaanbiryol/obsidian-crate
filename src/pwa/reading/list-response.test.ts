import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { loadReading } from './api';
import { commitReadingCache, type ReadingCache, type ReadingSession } from './storage';

vi.mock('./encryption-session', () => ({
  prepareReadingEncryption: async () => null,
  readingEncryptionHeaders: () => ({}),
}));
vi.mock('./storage', () => ({
  assertReadingSession: vi.fn(),
  commitReadingCache: vi.fn(async (_session: ReadingSession, cache: ReadingCache) => cache),
}));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const network = vi.fn<typeof fetch>();
const issue = { path: 'Reading/Damaged.md', message: 'Source could not be read.' };
function item(index: number, path = `Reading/${index}.md`): ReadingItem {
  return {
    crate_reading_version: 1, crate_reading_id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    title: `Article ${index}`, source_url: `https://example.com/${index}`, saved_at: '2026-10-01T12:00:00Z',
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
  expect(commitReadingCache).not.toHaveBeenCalled();
});

it('accepts queued captures, source issues and an empty terminal page as one revision', async () => {
  const queued = item(1, ''), article = item(2);
  respond({ items: [queued, article], issues: [issue], cursor: 'Reading/Last source.md' }, { items: [], issues: [], cursor: null });
  const cache = await loadReading(session);
  expect(network.mock.calls.map(([path]) => path)).toEqual(['/reading/list', '/reading/list?cursor=Reading%2FLast%20source.md']);
  expect(cache).toMatchObject({ items: [
    { ...queued, saved_at: '2026-10-01T12:00:00.000Z' },
    { ...article, saved_at: '2026-10-01T12:00:00.000Z' },
  ], issues: [issue] });
  expect(commitReadingCache).toHaveBeenCalledExactlyOnceWith(session, cache);
});

it('rejects a bad later page without publishing the valid prefix', async () => {
  respond({ items: [item(1)], issues: [], cursor: 'next' }, { items: [], issues: [], cursor: {} });
  await expect(loadReading(session)).rejects.toThrow('unreadable');
  expect(network).toHaveBeenCalledTimes(2);
  expect(commitReadingCache).not.toHaveBeenCalled();
});

it.each([['A', 'A'], ['A', 'B', 'A']])('stops a cursor cycle: %j', async (...cursors) => {
  respond(...cursors.map(cursor => ({ items: [], issues: [], cursor })));
  await expect(loadReading(session)).rejects.toThrow('Reading library did not advance.');
  expect(network).toHaveBeenCalledTimes(cursors.length);
  expect(commitReadingCache).not.toHaveBeenCalled();
});

it('bounds empty pages even when every cursor is different', async () => {
  network.mockImplementation(async () => Response.json({ items: [], issues: [], cursor: `page-${network.mock.calls.length}` }));
  await expect(loadReading(session)).rejects.toThrow('too large');
  expect(network).toHaveBeenCalledTimes(1000);
  expect(commitReadingCache).not.toHaveBeenCalled();
});

it.each(['items', 'issues'] as const)('rejects cumulative %s overflow on the terminal page', async field => {
  const records = field === 'items' ? Array.from({ length: 10_001 }, (_, index) => item(index)) : Array.from({ length: 10_001 }, () => issue);
  respond({ items: [], issues: [], [field]: records.slice(0, 6000), cursor: 'next' },
    { items: [], issues: [], [field]: records.slice(6000), cursor: null });
  await expect(loadReading(session)).rejects.toThrow('too large');
  expect(network).toHaveBeenCalledTimes(2);
  expect(commitReadingCache).not.toHaveBeenCalled();
});

it('accepts the item and issue budgets exactly, including a terminal page', async () => {
  const items = Array.from({ length: 10_000 }, (_, index) => item(index));
  const issues = Array.from({ length: 10_000 }, () => issue);
  respond({ items: items.slice(0, 6000), issues: issues.slice(0, 6000), cursor: 'next' },
    { items: items.slice(6000), issues: issues.slice(6000), cursor: null });
  const cache = await loadReading(session);
  expect(cache.items).toHaveLength(10_000);
  expect(cache.issues).toHaveLength(10_000);
  expect(commitReadingCache).toHaveBeenCalledExactlyOnceWith(session, cache);
});

it('retains duplicate-identity validation across otherwise valid pages', async () => {
  respond({ items: [item(1)], issues: [], cursor: 'next' }, { items: [item(1)], issues: [], cursor: null });
  await expect(loadReading(session)).rejects.toThrow('unreadable');
  expect(commitReadingCache).not.toHaveBeenCalled();
});
