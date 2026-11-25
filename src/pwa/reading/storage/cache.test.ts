import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { cacheReadingArticle, offlineReadingImagePaths, readOfflineReadingImage, readOfflineReadingItems, readReadingArticle, removeEarlierSessionCopies, removeReadingArticle } from './cache';
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
	getAllKeys: async () => [...values.keys()],
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
	expect(articleKeys()).toHaveLength(251);
	// A refresh keeps the copy's save time.
	expect(await cacheReadingArticle(session, item(0), 'Changed', { refresh: true })).toBe(true);
	expect(values.get(articleKey(0))).toMatchObject({ markdown: 'Changed', usedAt: 1_000 });
});

it('lists saved copies newest first for the offline library, skipping unreadable ones', async () => {
	await cacheReadingArticle(session, item(1, { saved_at: '2026-10-01T12:00:00Z' }), 'One');
	await cacheReadingArticle(session, item(2, { saved_at: '2026-10-02T12:00:00Z' }), 'Two');
	values.set(articleKey(4), { item: { ...item(4), path: 'Other/article.md' }, markdown: 'Wrong folder', usedAt: 1 });
	expect((await readOfflineReadingItems(session)).map(entry => entry.title)).toEqual(['Article 2', 'Article 1']);
});

it('removes only readable copies an earlier sign-in saved, never queues, drafts or attempts', async () => {
	await cacheReadingArticle(session, item(1), 'Mine');
	values.set(`pending:${session.id}`, []); values.set(`draft:${session.id}`, { url: 'https://example.test/draft' });
	values.set(`attempt:${session.id}:a`, { body: 'exact bytes' });
	values.set(`article:earlier:${item(2).crate_reading_id}`, { item: item(2), markdown: 'Earlier', usedAt: 1 });
	values.set(`article:earlier:${item(3).crate_reading_id}`, 'unreadable bytes');
	await removeEarlierSessionCopies(session);
	expect(articleKeys()).toEqual([articleKey(1), `article:earlier:${item(3).crate_reading_id}`]);
	expect([...values.keys()].filter(key => !key.startsWith('article:')).sort()).toEqual([`article-item:${session.id}:${item(1).crate_reading_id}`, `attempt:${session.id}:a`, `draft:${session.id}`, `pending:${session.id}`].sort());
});

it('lists saved copies from their items without reading their bodies', async () => {
	await cacheReadingArticle(session, item(1, { saved_at: '2026-10-01T12:00:00Z' }), 'One');
	await cacheReadingArticle(session, item(2, { saved_at: '2026-10-03T12:00:00Z' }), 'Two');
	await cacheReadingArticle(session, item(3, { saved_at: '2026-10-02T12:00:00Z' }), 'Three');
	vi.mocked(decodeReadingValue).mockClear();

	expect((await readOfflineReadingItems(session)).map(entry => entry.title)).toEqual(['Article 2', 'Article 3', 'Article 1']);
	const decoded = vi.mocked(decodeReadingValue).mock.calls.map(([key]) => key);
	expect(decoded.some(key => key.startsWith('article:'))).toBe(false);
});

it('removes an earlier sign-in\'s items with its copies, and items whose copy is gone', async () => {
	await cacheReadingArticle(session, item(1), 'Mine');
	values.set(`article:earlier:${item(2).crate_reading_id}`, { item: item(2), markdown: 'Earlier', usedAt: 1 });
	values.set(`article-item:earlier:${item(2).crate_reading_id}`, { item: item(2) });
	values.set(`article-item:${session.id}:${item(3).crate_reading_id}`, { item: item(3) });
	await removeEarlierSessionCopies(session);
	expect([...values.keys()].filter(key => key.startsWith('article-item:'))).toEqual([`article-item:${session.id}:${item(1).crate_reading_id}`]);
	await removeReadingArticle(session, item(1).crate_reading_id);
	expect([...values.keys()].filter(key => key.startsWith('article-item:'))).toEqual([]);
});

it('never reads this session\'s copies while removing earlier ones', async () => {
	await cacheReadingArticle(session, item(1), 'Mine');
	const read = vi.spyOn(values, 'get');
	await removeEarlierSessionCopies(session);
	expect(read.mock.calls.map(([key]) => key)).not.toContain(articleKey(1));
	expect(articleKeys()).toEqual([articleKey(1)]);
	read.mockRestore();
});

it('refreshes only copies the user saved', async () => {
	expect(await cacheReadingArticle(session, item(1), 'Online text', { refresh: true, etag: '"e"' })).toBe(false);
	expect(values.has(articleKey(1))).toBe(false);
	expect(await readReadingArticle(session, item(1).crate_reading_id)).toBeUndefined();
});

it('removes a saved copy', async () => {
	await cacheReadingArticle(session, item(1), 'One');
	await cacheReadingArticle(session, item(2), 'Two');
	await removeReadingArticle(session, item(1).crate_reading_id);
	expect(articleKeys()).toEqual([articleKey(2)]);
});

it('keeps an offline copy\'s images with it and removes them with it', async () => {
	const id = item(1).crate_reading_id, path = (n: number) => `Reading/attachments/${id}/${n}.png`;
	const image = { type: 'image/png', data: 'iVBORwE=' };
	await cacheReadingArticle(session, item(1), 'One', { images: { save: new Map([[path(1), image], [path(2), image]]), keep: new Set([path(1), path(2)]) } });
	expect(await offlineReadingImagePaths(session, id)).toEqual(new Set([path(1), path(2)]));
	const blob = await readOfflineReadingImage(session, id, path(1));
	expect(blob?.type).toBe('image/png');
	expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 1]);
	// A refreshed copy keeps the images it still links to and drops the rest.
	await cacheReadingArticle(session, item(1), 'One again', { refresh: true, images: { save: new Map(), keep: new Set([path(2)]) } });
	expect(await offlineReadingImagePaths(session, id)).toEqual(new Set([path(2)]));
	// Another session's image, and one whose copy is gone, are removed with the earlier sign-in's copies.
	values.set(`article-image:other:${id}:${path(1)}`, image);
	values.set(`article-image:${session.id}:${item(2).crate_reading_id}:Reading/x.png`, image);
	await removeEarlierSessionCopies(session);
	expect([...values.keys()].filter(key => key.startsWith('article-image:'))).toEqual([`article-image:${session.id}:${id}:${path(2)}`]);
	await removeReadingArticle(session, id);
	expect([...values.keys()]).toEqual([]);
});
