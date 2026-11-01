import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingItem } from '@/reading/core/model';
import { loadReadingArticle } from './api';
import { cacheReadingArticle, readingArticlesToPrefetch } from './storage/cache';
import { prefetchReadingArticles } from './prefetch';
import type { ReadingSession } from './session/session';

vi.mock('./api', () => ({ loadReadingArticle: vi.fn() }));
vi.mock('./storage/cache', () => ({ cacheReadingArticle: vi.fn(async () => true), readingArticlesToPrefetch: vi.fn() }));

const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const item = (n: number) => ({ crate_reading_id: `id-${n}` }) as ReadingItem;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('navigator', { onLine: true });
	vi.mocked(readingArticlesToPrefetch).mockResolvedValue([item(1), item(2), item(3)]);
	vi.mocked(loadReadingArticle).mockImplementation(async (_session, id) => ({ item: { crate_reading_id: id } as ReadingItem, markdown: `Body ${id}` }));
});
afterEach(() => vi.unstubAllGlobals());

it('saves each picked article as a background copy', async () => {
	await prefetchReadingArticles(session, [], () => true);
	expect(readingArticlesToPrefetch).toHaveBeenCalledWith(session, [], 10);
	expect(cacheReadingArticle).toHaveBeenCalledTimes(3);
	expect(cacheReadingArticle).toHaveBeenCalledWith(session, { crate_reading_id: 'id-3' }, 'Body id-3', { prefetched: true });
});

it('downloads at most three articles at a time', async () => {
	vi.mocked(readingArticlesToPrefetch).mockResolvedValue([1, 2, 3, 4, 5, 6].map(item));
	let active = 0, peak = 0;
	vi.mocked(loadReadingArticle).mockImplementation(async (_session, id) => {
		peak = Math.max(peak, ++active);
		await new Promise(resolve => setTimeout(resolve, 1));
		active--;
		return { item: { crate_reading_id: id } as ReadingItem, markdown: '', etag: '"e"' };
	});
	await prefetchReadingArticles(session, [], () => true);
	expect(peak).toBe(3);
	expect(cacheReadingArticle).toHaveBeenCalledTimes(6);
	expect(cacheReadingArticle).toHaveBeenCalledWith(session, { crate_reading_id: 'id-6' }, '', { prefetched: true, etag: '"e"' });
});

it('stops when the cache has no room, the session changes or the device goes offline', async () => {
	vi.mocked(readingArticlesToPrefetch).mockResolvedValue([1, 2, 3, 4, 5].map(item));
	vi.mocked(cacheReadingArticle).mockResolvedValueOnce(false);
	await prefetchReadingArticles(session, [], () => true);
	// Downloads already running finish; no more start.
	expect(loadReadingArticle).toHaveBeenCalledTimes(3);

	vi.clearAllMocks();
	let current = true;
	vi.mocked(loadReadingArticle).mockImplementationOnce(async (_session, id) => { current = false; return { item: { crate_reading_id: id } as ReadingItem, markdown: '' }; });
	await prefetchReadingArticles(session, [], () => current);
	expect(cacheReadingArticle).not.toHaveBeenCalled();

	vi.clearAllMocks();
	vi.stubGlobal('navigator', { onLine: false });
	await prefetchReadingArticles(session, [], () => true);
	expect(loadReadingArticle).not.toHaveBeenCalled();
});

it('leaves failures for the next refresh, continues past them, and respects Data Saver', async () => {
	vi.mocked(loadReadingArticle).mockRejectedValueOnce(new Error('Unavailable'));
	await prefetchReadingArticles(session, [], () => true);
	expect(loadReadingArticle).toHaveBeenCalledTimes(3);
	expect(cacheReadingArticle).toHaveBeenCalledTimes(2);

	vi.clearAllMocks();
	vi.stubGlobal('navigator', { onLine: true, connection: { saveData: true } });
	await prefetchReadingArticles(session, [], () => true);
	expect(readingArticlesToPrefetch).not.toHaveBeenCalled();
});
