import type { ReadingItem } from '@/reading/core/model';
import { loadReadingArticle } from './api';
import { cacheReadingArticle, readingArticlesToPrefetch } from './cache';
import type { ReadingSession } from './session';

// Each refresh saves a few more, so a large inbox fills in without a burst of requests.
const PREFETCH_PER_REFRESH = 10;

/**
 * Saves the newest unread articles while online so they open offline without a
 * first visit. Stops at the first failure and waits for the next refresh.
 */
export async function prefetchReadingArticles(session: ReadingSession, items: ReadingItem[], isCurrent: () => boolean) {
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  for (const item of await readingArticlesToPrefetch(session, items, PREFETCH_PER_REFRESH)) {
    if (!navigator.onLine || !isCurrent()) return;
    const article = await loadReadingArticle(session, item.crate_reading_id);
    if (!isCurrent() || !await cacheReadingArticle(session, article.item, article.markdown, { prefetched: true })) return;
  }
}
