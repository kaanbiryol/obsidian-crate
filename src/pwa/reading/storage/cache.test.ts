import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { cacheReadingArticle, commitReadingCache, readReadingArticle, removeReadingArticle } from './cache';
import { isReadingCache } from './storage-validation';
import { decodeReadingValue } from './private-storage';
import { READING_SESSION_KEY, type ReadingSession } from '../session/session';
import { AUTH_TOKEN_KEY } from '../../config';

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./private-storage', async importOriginal => {
	const actual = await importOriginal<typeof import('./private-storage')>();
	return { ...actual, decodeReadingValue: vi.fn(actual.decodeReadingValue) };
});
vi.mock('./storage-validation', async importOriginal => {
	const actual = await importOriginal<typeof import('./storage-validation')>();
	return { ...actual, isReadingCache: vi.fn(actual.isReadingCache) };
});
vi.mock('../../storage/single-store-database', () => ({ openSingleStoreDatabase: async () => ({
	get: async (_store: string, key: string) => values.get(key),
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
const articleKeys = () => [...values.keys()].filter(key => key.startsWith('article:'));
const articleKey = (n: number) => `article:${session.id}:${item(n).crate_reading_id}`;
const articleDecodes = () => vi.mocked(decodeReadingValue).mock.calls.filter(([key]) => key.startsWith('article:')).length;

beforeEach(() => {
	values.clear(); vi.mocked(decodeReadingValue).mockClear(); vi.mocked(isReadingCache).mockClear();
	vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(session) : key === AUTH_TOKEN_KEY ? session.token : null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('refuses a save past the limits instead of evicting a saved copy', async () => {
	vi.useFakeTimers();
	for (let n = 0; n < 199; n++) values.set(articleKey(n), { item: item(n), markdown: `Body ${n}`, usedAt: n, offline: true });
	vi.setSystemTime(1_000);
	expect(await cacheReadingArticle(session, item(199), 'Body 199')).toBe(true);
	// A missing index is rebuilt once from the saved copies.
	expect(articleDecodes()).toBe(199);

	vi.mocked(decodeReadingValue).mockClear();
	expect(await cacheReadingArticle(session, item(200), 'Body 200')).toBe(false);
	// Once indexed, no saved copy is decoded, and none is removed.
	expect(articleDecodes()).toBe(0);
	expect(values.has(articleKey(200))).toBe(false);
	expect(articleKeys()).toHaveLength(200);
	// A refresh of a saved copy is always kept.
	expect(await cacheReadingArticle(session, item(0), 'Changed', { refresh: true })).toBe(true);
	expect(values.get(articleKey(0))).toMatchObject({ markdown: 'Changed', offline: true, usedAt: 0 });
});

it('indexes saved copies stored outside the index and refuses a save past the byte limit', async () => {
	vi.useFakeTimers(); vi.setSystemTime(1_000);
	values.set(articleKey(1), { item: item(1), markdown: 'One', usedAt: 1, offline: true });
	await cacheReadingArticle(session, item(2), 'Two');
	values.delete(articleKey(1));
	values.set(articleKey(3), { item: item(3), markdown: 'x'.repeat(50 * 1024 * 1024), usedAt: 3, offline: true });
	expect(await cacheReadingArticle(session, item(4), 'Four')).toBe(false);
	expect(values.has(articleKey(3))).toBe(true);
	expect(values.get(`article-index:${session.id}`)).toMatchObject({ version: 2, entries: [{ id: item(2).crate_reading_id, bytes: 3 }, { id: item(1).crate_reading_id, bytes: 3 }] });
});

it('preserves unreadable article copies and rebuilds a malformed index', async () => {
	values.set(articleKey(1), { item: { ...item(1), path: 'Other/article.md' }, markdown: 'Wrong folder', usedAt: 1 });
	values.set(`article-index:${session.id}`, { version: 2, entries: [{ id: 'damaged' }] });
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

it('refreshes only copies the user saved', async () => {
	expect(await cacheReadingArticle(session, item(1), 'Online text', { refresh: true, etag: '"e"' })).toBe(false);
	expect(values.has(articleKey(1))).toBe(false);
	values.set(articleKey(2), { item: item(2), markdown: 'Opened by an older version', usedAt: 1 });
	expect(await cacheReadingArticle(session, item(2), 'Newer', { refresh: true })).toBe(false);
	expect(await readReadingArticle(session, item(2).crate_reading_id)).toBeUndefined();
});

it('removes copies earlier versions stored without being asked and keeps saved ones', async () => {
	values.set(articleKey(1), { item: item(1), markdown: 'Opened', usedAt: 1 });
	values.set(articleKey(2), { item: item(2), markdown: 'Background', usedAt: 2, prefetched: true });
	values.set(articleKey(3), { item: item(3), markdown: 'Saved', usedAt: 3, offline: true });
	values.set(`article-index:${session.id}`, { version: 1, entries: [1, 2, 3].map(n => ({ id: item(n).crate_reading_id, usedAt: n, bytes: 5 })) });
	await commitReadingCache(session, { items: [item(1), item(2), item(3)], issues: [], savedAt: 1 });
	expect(articleKeys()).toEqual([articleKey(3)]);
	expect(values.get(`article-index:${session.id}`)).toMatchObject({ version: 2, entries: [{ id: item(3).crate_reading_id, bytes: 5 }] });
	// With a current index, a later commit decodes no saved copy.
	vi.mocked(decodeReadingValue).mockClear();
	await commitReadingCache(session, { items: [item(3)], issues: [], savedAt: 2 });
	expect(articleDecodes()).toBe(0);
});

it('removes a saved copy and its index entry', async () => {
	await cacheReadingArticle(session, item(1), 'One');
	await cacheReadingArticle(session, item(2), 'Two');
	await removeReadingArticle(session, item(1).crate_reading_id);
	expect(articleKeys()).toEqual([articleKey(2)]);
	expect(values.get(`article-index:${session.id}`)).toMatchObject({ entries: [{ id: item(2).crate_reading_id }] });
});
