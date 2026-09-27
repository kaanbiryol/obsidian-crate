import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { createDetailHistory } from '../detail-history';

const articles = createDetailHistory({
	stackKey: 'readingStackId', detailKey: 'readingArticle',
	closedKey: 'readingLibrary', parameter: 'item',
});

export const hasReadingArticleHistory = articles.hasDetail;
export const dismissReadingArticleHistory = articles.dismiss;

export function openReadingArticleHistory(itemId: string, section: ReadingSection = 'inbox'): Promise<string | null> {
	const detail = new URL(`/notifications?section=reading&item=${encodeURIComponent(itemId)}`, location.href);
	const library = new URL(location.href);
	library.searchParams.set('section', 'reading');
	return articles.open(detail, true, { readingSection: section }, library);
}
