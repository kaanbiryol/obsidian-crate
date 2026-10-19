import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { cacheReadingArticle } from './cache';
import { decodeReadingValue } from './private-storage';
import { READING_SESSION_KEY, type ReadingSession } from './session';

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./private-storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./private-storage')>();
  return { ...actual, decodeReadingValue: vi.fn(actual.decodeReadingValue) };
});
vi.mock('../single-store-database', () => ({ openSingleStoreDatabase: async () => ({
  transaction: () => ({
    store: {
      getAllKeys: async () => [...values.keys()], get: async (key: string) => values.get(key),
      put: async (value: unknown, key: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); },
    },
    done: Promise.resolve(),
  }),
}) }));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const item = (n: number): ReadingItem => ({ crate_reading_version: 1, crate_reading_id: `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`,
  title: `Article ${n}`, path: `Reading/article-${n}.md`, source_url: 'https://example.test/article',
  saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' });
const articleKey = (n: number) => `article:${session.id}:${item(n).crate_reading_id}`;
const articleDecodes = () => vi.mocked(decodeReadingValue).mock.calls.filter(([key]) => key.startsWith('article:')).length;

beforeEach(() => {
  values.clear(); vi.mocked(decodeReadingValue).mockClear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(session) : null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('evicts least recently used articles from the use index without decoding retained copies', async () => {
  vi.useFakeTimers();
  for (let n = 0; n < 50; n++) values.set(articleKey(n), { item: item(n), markdown: `Body ${n}`, usedAt: n });
  vi.setSystemTime(1_000);
  await cacheReadingArticle(session, item(50), 'Body 50');
  // A missing index is rebuilt once from the saved copies.
  expect(articleDecodes()).toBe(50);
  expect(values.has(articleKey(0))).toBe(false);

  vi.mocked(decodeReadingValue).mockClear();
  vi.setSystemTime(2_000);
  await cacheReadingArticle(session, item(51), 'Body 51');
  // Once indexed, no retained or evicted copy is decoded.
  expect(articleDecodes()).toBe(0);
  expect(values.has(articleKey(1))).toBe(false);
  expect(values.has(articleKey(2))).toBe(true);
  expect([...values.keys()].filter(key => key.startsWith('article:'))).toHaveLength(50);
});

it('indexes copies saved outside the index and drops pruned entries', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  values.set(articleKey(1), { item: item(1), markdown: 'One', usedAt: 1 });
  await cacheReadingArticle(session, item(2), 'Two');
  vi.setSystemTime(2_000);
  values.delete(articleKey(1));
  values.set(articleKey(3), { item: item(3), markdown: 'x'.repeat(20 * 1024 * 1024), usedAt: 3 });
  await cacheReadingArticle(session, item(4), 'Four');
  expect(values.has(articleKey(3))).toBe(false);
  expect(values.get(`article-index:${session.id}`)).toMatchObject({ version: 1, entries: [{ id: item(4).crate_reading_id, bytes: 4 }, { id: item(2).crate_reading_id, bytes: 3 }] });
});

it('preserves unreadable article copies and rebuilds a malformed index', async () => {
  values.set(articleKey(1), { item: { ...item(1), path: 'Other/article.md' }, markdown: 'Wrong folder', usedAt: 1 });
  values.set(`article-index:${session.id}`, { version: 1, entries: [{ id: 'damaged' }] });
  await cacheReadingArticle(session, item(2), 'Two');
  expect(values.has(articleKey(1))).toBe(true);
  expect(values.get(`article-index:${session.id}`)).toMatchObject({ entries: [{ id: item(2).crate_reading_id }] });
});
