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
	expect(cacheReadingArticle).toHaveBeenLastCalledWith(session, { crate_reading_id: 'id-3' }, 'Body id-3', { prefetched: true });
});

it('stops when the cache has no room, the session changes or the device goes offline', async () => {
	vi.mocked(cacheReadingArticle).mockResolvedValueOnce(false);
	await prefetchReadingArticles(session, [], () => true);
	expect(loadReadingArticle).toHaveBeenCalledOnce();

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

it('leaves failures for the next refresh and respects Data Saver', async () => {
	vi.mocked(loadReadingArticle).mockRejectedValueOnce(new Error('Unavailable'));
	await expect(prefetchReadingArticles(session, [], () => true)).rejects.toThrow('Unavailable');
	expect(loadReadingArticle).toHaveBeenCalledOnce();

	vi.clearAllMocks();
	vi.stubGlobal('navigator', { onLine: true, connection: { saveData: true } });
	await prefetchReadingArticles(session, [], () => true);
	expect(readingArticlesToPrefetch).not.toHaveBeenCalled();
});
