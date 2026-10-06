import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { renderHook } from '../../test/react-hooks';
import { loadReadingArticle } from './api';
import { cacheReadingArticle, readReadingArticle, READING_SESSION_KEY, type ReadingCache, type ReadingSession } from './storage';
import { useReadingArticle } from './useReadingArticle';

vi.mock('./encryption-session', () => ({ prepareReadingEncryption: vi.fn(async () => null), readingEncryptionHeaders: () => ({}) }));
vi.mock('./storage', async importOriginal => ({
  ...await importOriginal<typeof import('./storage')>(),
  readReadingArticle: vi.fn(), cacheReadingArticle: vi.fn(async () => {}),
}));
vi.mock('./article-history', () => ({
  openReadingArticleHistory: async (id: string) => {
    location.href = `https://example.test/notifications?section=reading&item=${id}`;
    return 'article-stack';
  },
  hasReadingArticleHistory: () => true,
  dismissReadingArticleHistory: vi.fn(),
}));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'one', folderPath: 'Reading', expiresAt: 1 };
const item: ReadingItem = { crate_reading_version: 1, crate_reading_id: '12345678-1234-4123-8123-123456789abc',
  title: 'Saved article', path: 'Reading/article.md', source_url: 'https://example.test/article',
  saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' };
const saved = { item, markdown: 'Verified saved article.', usedAt: 1 };
const network = vi.fn<typeof fetch>();
const reportSessionError = vi.fn();
const malformed = [
  { reason: 'non-text Markdown', value: { item, markdown: { text: 'Unreadable' } } },
  { reason: 'a different article ID', value: { item: { ...item, crate_reading_id: '87654321-1234-4123-8123-123456789abc' }, markdown: 'Wrong article.' } },
  { reason: 'a path outside the folder', value: { item: { ...item, path: 'Other/article.md' }, markdown: 'Wrong folder.' } },
];

beforeEach(() => {
  vi.clearAllMocks(); network.mockReset();
  vi.mocked(readReadingArticle).mockReset().mockResolvedValue(saved);
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(session) : null });
  vi.stubGlobal('location', { href: 'https://example.test/notifications?section=reading' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

function harness() {
  let cache: ReadingCache = { items: [item], issues: [], savedAt: 1 };
  const hook = renderHook(() => useReadingArticle({ session, cache, pending: [], isCurrentSession: () => true,
    reportSessionError, run: async action => action() }));
  return { hook, update: (next: ReadingItem) => { cache = { ...cache, items: [next] }; hook.rerender(); } };
}

it('loads a validated live article without changing its content', async () => {
  const article = { item, markdown: 'A complete online article.' };
  network.mockResolvedValue(Response.json(article));
  await expect(loadReadingArticle(session, item.crate_reading_id)).resolves.toEqual(article);
  expect(network.mock.calls[0]?.[0]).toBe(`/reading/item?id=${item.crate_reading_id}`);
});

it.each(malformed)('keeps the saved reader and offline copy when opening receives $reason', async ({ value }) => {
  network.mockResolvedValue(Response.json(value));
  const { hook } = harness();
  await act(async () => { await hook.current.open(item); });
  expect(hook.current.reader).toMatchObject({ item, markdown: saved.markdown, availableOffline: true });
  expect(cacheReadingArticle).not.toHaveBeenCalled();
  expect(reportSessionError).toHaveBeenLastCalledWith(session, 'Showing saved copy. Reading article response is unreadable.');
});

it.each(malformed)('keeps confirmed text and cache when a background refresh receives $reason', async ({ value }) => {
  network.mockResolvedValueOnce(Response.json({ item, markdown: 'Confirmed online text.' }));
  const { hook, update } = harness();
  await act(async () => { await hook.current.open(item); });
  expect(hook.current.reader?.markdown).toBe('Confirmed online text.');
  expect(cacheReadingArticle).toHaveBeenCalledOnce();
  vi.mocked(cacheReadingArticle).mockClear();
  network.mockResolvedValueOnce(Response.json(value));
  await act(async () => { update({ ...item, extraction_status: 'pending' }); });
  expect(network).toHaveBeenCalledTimes(2);
  expect(hook.current.reader?.markdown).toBe('Confirmed online text.');
  expect(cacheReadingArticle).not.toHaveBeenCalled();
  expect(reportSessionError).toHaveBeenLastCalledWith(session, 'Reading article response is unreadable.');
});

it('shows a load error without publishing invalid Markdown when no saved copy exists', async () => {
  vi.mocked(readReadingArticle).mockResolvedValue(undefined);
  network.mockResolvedValue(Response.json(malformed[0]!.value));
  const { hook } = harness();
  await act(async () => { await hook.current.open(item); });
  expect(hook.current.reader).toMatchObject({ item, markdown: null, availableOffline: false, error: 'Reading article response is unreadable.' });
  expect(cacheReadingArticle).not.toHaveBeenCalled();
});
