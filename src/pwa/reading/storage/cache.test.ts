import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { cacheReadingArticle, commitReadingCache, readOfflineReadingItems, readReadingArticle, removeReadingArticle } from './cache';
import { decodeReadingValue } from './private-storage';
import { READING_SESSION_KEY, type ReadingSession } from '../session/session';
import { AUTH_TOKEN_KEY } from '../../config';

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./private-storage', async importOriginal => {
	const actual = await importOriginal<typeof import('./private-storage')>();
	return { ...actual, decodeReadingValue: vi.fn(actual.decodeReadingValue) };
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
	values.clear(); vi.mocked(decodeReadingValue).mockClear();
	vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(session) : key === AUTH_TOKEN_KEY ? session.token : null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps every saved copy, with no count or size limit of its own, whatever a page lists', async () => {
	vi.useFakeTimers(); vi.setSystemTime(1_000);
	const items = Array.from({ length: 250 }, (_, n) => item(n));
	for (const entry of items) expect(await cacheReadingArticle(session, entry, `Body ${entry.title}`)).toBe(true);
	expect(await cacheReadingArticle(session, item(250), 'x'.repeat(60 * 1024 * 1024))).toBe(true);
	// A page is not the whole library, so a commit neither reads nor removes saved copies.
	vi.mocked(decodeReadingValue).mockClear();
	await commitReadingCache(session, { items: [item(1)], issues: [], savedAt: 1 });
	expect(articleDecodes()).toBe(0);
	expect(articleKeys()).toHaveLength(251);
	// A refresh keeps the copy's save time.
	expect(await cacheReadingArticle(session, item(0), 'Changed', { refresh: true })).toBe(true);
	expect(values.get(articleKey(0))).toMatchObject({ markdown: 'Changed', offline: true, usedAt: 1_000 });
});

it('lists saved copies newest first for the offline library, skipping unreadable and unsaved ones', async () => {
	await cacheReadingArticle(session, item(1, { saved_at: '2026-10-01T12:00:00Z' }), 'One');
	await cacheReadingArticle(session, item(2, { saved_at: '2026-10-02T12:00:00Z' }), 'Two');
	values.set(articleKey(3), { item: item(3), markdown: 'Opened by an older version', usedAt: 1 });
	values.set(articleKey(4), { item: { ...item(4), path: 'Other/article.md' }, markdown: 'Wrong folder', usedAt: 1, offline: true });
	expect((await readOfflineReadingItems(session)).map(entry => entry.title)).toEqual(['Article 2', 'Article 1']);
	// Unreadable copies stay for export.
	await commitReadingCache(session, { items: [], issues: [], savedAt: 1 });
	expect(values.has(articleKey(4))).toBe(true);
});

it('refreshes only copies the user saved', async () => {
	expect(await cacheReadingArticle(session, item(1), 'Online text', { refresh: true, etag: '"e"' })).toBe(false);
	expect(values.has(articleKey(1))).toBe(false);
	values.set(articleKey(2), { item: item(2), markdown: 'Opened by an older version', usedAt: 1 });
	expect(await cacheReadingArticle(session, item(2), 'Newer', { refresh: true })).toBe(false);
	expect(await readReadingArticle(session, item(2).crate_reading_id)).toBeUndefined();
});

it('removes a saved copy', async () => {
	await cacheReadingArticle(session, item(1), 'One');
	await cacheReadingArticle(session, item(2), 'Two');
	await removeReadingArticle(session, item(1).crate_reading_id);
	expect(articleKeys()).toEqual([articleKey(2)]);
});
