import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { cacheReadingArticle, commitReadingCache, readingArticlesToPrefetch } from './cache';
import { isReadingCache } from './storage-validation';
import { decodeReadingValue } from './private-storage';
import { READING_SESSION_KEY, type ReadingSession } from './session';

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./private-storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./private-storage')>();
  return { ...actual, decodeReadingValue: vi.fn(actual.decodeReadingValue) };
});
vi.mock('./storage-validation', async importOriginal => {
  const actual = await importOriginal<typeof import('./storage-validation')>();
  return { ...actual, isReadingCache: vi.fn(actual.isReadingCache) };
});
vi.mock('../storage/single-store-database', () => ({ openSingleStoreDatabase: async () => ({
  transaction: () => ({
    store: {
      getAllKeys: async () => [...values.keys()], get: async (key: string) => values.get(key),
      put: async (value: unknown, key: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); },
    },
    done: Promise.resolve(),
  }),
}) }));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const item = (n: number, changes: Partial<ReadingItem> = {}): ReadingItem => ({ crate_reading_version: 1, crate_reading_id: `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`,
  title: `Article ${n}`, path: `Reading/article-${n}.md`, source_url: 'https://example.test/article',
  saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', ...changes });
const savedOn = (day: number) => `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`;
const articleKeys = () => [...values.keys()].filter(key => key.startsWith('article:'));
const articleKey = (n: number) => `article:${session.id}:${item(n).crate_reading_id}`;
const articleDecodes = () => vi.mocked(decodeReadingValue).mock.calls.filter(([key]) => key.startsWith('article:')).length;

beforeEach(() => {
  values.clear(); vi.mocked(decodeReadingValue).mockClear(); vi.mocked(isReadingCache).mockClear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(session) : null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('evicts least recently used articles from the use index without decoding retained copies', async () => {
  vi.useFakeTimers();
  for (let n = 0; n < 200; n++) values.set(articleKey(n), { item: item(n), markdown: `Body ${n}`, usedAt: n });
  vi.setSystemTime(1_000);
  await cacheReadingArticle(session, item(200), 'Body 200');
  // A missing index is rebuilt once from the saved copies.
  expect(articleDecodes()).toBe(200);
  expect(values.has(articleKey(0))).toBe(false);

  vi.mocked(decodeReadingValue).mockClear();
  vi.setSystemTime(2_000);
  await cacheReadingArticle(session, item(201), 'Body 201');
  // Once indexed, no retained or evicted copy is decoded.
  expect(articleDecodes()).toBe(0);
  expect(values.has(articleKey(1))).toBe(false);
  expect(values.has(articleKey(2))).toBe(true);
  expect(articleKeys()).toHaveLength(200);
});

it('indexes copies saved outside the index and drops pruned entries', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  values.set(articleKey(1), { item: item(1), markdown: 'One', usedAt: 1 });
  await cacheReadingArticle(session, item(2), 'Two');
  vi.setSystemTime(2_000);
  values.delete(articleKey(1));
  values.set(articleKey(3), { item: item(3), markdown: 'x'.repeat(50 * 1024 * 1024), usedAt: 3 });
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

it('validates the previous library only to keep entries for notes with source issues', async () => {
  values.set(`list:${session.id}`, { items: [item(1)], issues: [], savedAt: 1 });
  await commitReadingCache(session, { items: [item(2)], issues: [], savedAt: 2 });
  expect(isReadingCache).not.toHaveBeenCalled();
  expect(values.get(`list:${session.id}`)).toMatchObject({ items: [{ crate_reading_id: item(2).crate_reading_id }] });

  const kept = await commitReadingCache(session, { items: [], issues: [{ path: item(2).path, message: 'Unreadable' }], savedAt: 3 });
  expect(isReadingCache).toHaveBeenCalledOnce();
  expect(kept.items).toEqual([item(2)]);
});

it('keeps articles opened on this device ahead of background copies', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-20T00:00:00Z'));
  for (let n = 0; n < 199; n++) values.set(articleKey(n), { item: item(n), markdown: `Body ${n}`, usedAt: n });
  // A background copy fills the last slot, ranked by its save date.
  expect(await cacheReadingArticle(session, item(300, { saved_at: savedOn(15) }), 'New', { prefetched: true })).toBe(true);
  expect(values.get(articleKey(300))).toMatchObject({ prefetched: true, usedAt: Date.parse(savedOn(15)) });
  // An opened article displaces the background copy, not an older opened one.
  expect(await cacheReadingArticle(session, item(301), 'Opened')).toBe(true);
  expect(values.has(articleKey(300))).toBe(false);
  expect(values.has(articleKey(0))).toBe(true);
  // With every slot opened, a background copy is evicted at once and reported as not kept.
  expect(await cacheReadingArticle(session, item(302, { saved_at: savedOn(19) }), 'Later', { prefetched: true })).toBe(false);
  expect(values.has(articleKey(302))).toBe(false);
  expect(articleKeys()).toHaveLength(200);
});

it('never replaces a saved copy with a background one', async () => {
  values.set(articleKey(1), { item: item(1), markdown: 'Opened text', usedAt: 5 });
  expect(await cacheReadingArticle(session, item(1), 'Background text', { prefetched: true })).toBe(true);
  expect(values.get(articleKey(1))).toEqual({ item: item(1), markdown: 'Opened text', usedAt: 5 });
  // Opening a background copy promotes it.
  values.set(articleKey(2), { item: item(2), markdown: 'Two', usedAt: 1, prefetched: true });
  await cacheReadingArticle(session, item(2), 'Two');
  expect(values.get(articleKey(2))).not.toHaveProperty('prefetched');
});

it('picks the newest ready inbox articles that are not saved yet', async () => {
  values.set(articleKey(1), { item: item(1), markdown: 'Saved', usedAt: 1 });
  const items = [item(1, { saved_at: savedOn(20) }), item(2, { saved_at: savedOn(10) }), item(3, { saved_at: savedOn(12) }),
    item(4, { reading_status: 'archived', saved_at: savedOn(21) }), item(5, { extraction_status: 'pending', saved_at: savedOn(22) }),
    item(6, { path: '', saved_at: savedOn(23) }), item(7, { saved_at: savedOn(11) })];
  expect((await readingArticlesToPrefetch(session, items, 2)).map(entry => entry.crate_reading_id)).toEqual([item(3).crate_reading_id, item(7).crate_reading_id]);
});

it('skips downloads that could not displace the copies already kept', async () => {
  const entries = [];
  for (let n = 0; n < 199; n++) { values.set(articleKey(n), { item: item(n), markdown: 'Opened', usedAt: n }); entries.push({ id: item(n).crate_reading_id, usedAt: n, bytes: 6 }); }
  values.set(articleKey(199), { item: item(199), markdown: 'Background', usedAt: Date.parse(savedOn(15)), prefetched: true });
  entries.push({ id: item(199).crate_reading_id, usedAt: Date.parse(savedOn(15)), bytes: 10, prefetched: true });
  values.set(`article-index:${session.id}`, { version: 1, entries });
  const pick = (day: number) => readingArticlesToPrefetch(session, [item(500, { saved_at: savedOn(day) })], 10);
  expect(await pick(10)).toEqual([]);
  expect(await pick(20)).toHaveLength(1);
  // Copies missing from the index count as opened, so nothing is fetched.
  values.delete(`article-index:${session.id}`);
  expect(await pick(20)).toEqual([]);
});
