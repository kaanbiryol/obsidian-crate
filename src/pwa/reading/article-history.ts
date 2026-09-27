import { createDetailStack, isCurrentDetailStack } from '../detail-history';

interface ReadingHistoryEntry {
	readingArticle?: boolean;
	readingLibrary?: boolean;
	readingStackId?: string;
}

export function hasReadingArticleHistory(): boolean {
	return Boolean((history.state as ReadingHistoryEntry | null)?.readingArticle);
}

/** Reuse one detail slot so repeated open/dismiss cycles cannot grow browser history. */
export function openReadingArticleHistory(itemId: string): string {
	const entry = history.state as ReadingHistoryEntry | null;
	const url = `/notifications?section=reading&item=${encodeURIComponent(itemId)}`;
	if (entry?.readingStackId && isCurrentDetailStack(entry.readingStackId) && (entry.readingArticle || entry.readingLibrary)) {
		history.replaceState({ readingArticle: true, readingStackId: entry.readingStackId }, '', url);
		return entry.readingStackId;
	}
	const stackId = createDetailStack();
	const library = new URL(location.href);
	library.searchParams.set('section', 'reading'); library.searchParams.delete('item');
	history.replaceState({ readingStackId: stackId }, '', library);
	history.pushState({ readingArticle: true, readingStackId: stackId }, '', url);
	return stackId;
}

/** After Back reaches our library entry, replace the forward article with a closed slot. */
export function dismissReadingArticleHistory(stackId: string | null): void {
	const entry = history.state as ReadingHistoryEntry | null;
	if (!stackId || entry?.readingStackId !== stackId || entry.readingArticle || entry.readingLibrary
		|| new URL(location.href).searchParams.has('item')) return;
	// pushState removes the forward destination; the next open replaces this slot.
	history.pushState({ readingLibrary: true, readingStackId: stackId }, '', location.href);
}
