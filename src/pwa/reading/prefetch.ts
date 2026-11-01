import type { ReadingItem } from '@/reading/core/model';
import { loadReadingArticle } from './api';
import { cacheReadingArticle, readingArticlesToPrefetch } from './storage/cache';
import type { ReadingSession } from './session/session';
import { mapBounded } from '@/platform/map-bounded';

// Each refresh saves a few more, so a large inbox fills in without a burst of requests.
const PREFETCH_PER_REFRESH = 10;
// A few downloads at a time leave connections free for the library and the open article.
const PREFETCH_CONCURRENCY = 3;

/**
 * Saves the newest unread articles while online so they open offline without a
 * first visit. A failed download is skipped until the next refresh; once a copy
 * is not kept, the rest would not be either, so no more start.
 */
export async function prefetchReadingArticles(session: ReadingSession, items: ReadingItem[], isCurrent: () => boolean) {
	if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
	let stopped = false;
	await mapBounded(await readingArticlesToPrefetch(session, items, PREFETCH_PER_REFRESH), PREFETCH_CONCURRENCY, async item => {
		if (stopped || !navigator.onLine || !isCurrent()) return;
		try {
			const article = await loadReadingArticle(session, item.crate_reading_id);
			if (!isCurrent() || !await cacheReadingArticle(session, article.item, article.markdown, { prefetched: true, etag: article.etag })) stopped = true;
		} catch { /* Retried on the next refresh. */ }
	});
}
