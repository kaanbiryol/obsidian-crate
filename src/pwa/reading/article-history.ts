import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { createDetailStack, isCurrentDetailStack } from '../detail-history';

interface ReadingHistoryEntry {
	readingArticle?: boolean;
	readingLibrary?: boolean;
	readingStackId?: string;
	readingSection?: ReadingSection;
}

export function hasReadingArticleHistory(): boolean {
	return Boolean((history.state as ReadingHistoryEntry | null)?.readingArticle);
}

/** Reuse a detail slot while its originating tab remains the Back destination. */
export function openReadingArticleHistory(itemId: string, section: ReadingSection = 'inbox'): string {
	const entry = history.state as ReadingHistoryEntry | null;
	const url = `/notifications?section=reading&item=${encodeURIComponent(itemId)}`;
	if (entry?.readingStackId && isCurrentDetailStack(entry.readingStackId) && (entry.readingArticle || (entry.readingLibrary && entry.readingSection === section))) {
		history.replaceState({ readingArticle: true, readingStackId: entry.readingStackId, readingSection: entry.readingSection }, '', url);
		return entry.readingStackId;
	}
	// A reused slot retains its predecessor’s native swipe snapshot. A different
	// library tab needs a new predecessor, even though popstate restores live state.
	const stackId = createDetailStack();
	const library = new URL(location.href);
	library.searchParams.set('section', 'reading'); library.searchParams.delete('item');
	history.replaceState({ readingStackId: stackId, readingSection: section }, '', library);
	history.pushState({ readingArticle: true, readingStackId: stackId, readingSection: section }, '', url);
	return stackId;
}

/** After Back reaches our library entry, replace the forward article with a closed slot. */
export function dismissReadingArticleHistory(stackId: string | null): void {
	const entry = history.state as ReadingHistoryEntry | null;
	if (!stackId || entry?.readingStackId !== stackId || entry.readingArticle || entry.readingLibrary
		|| new URL(location.href).searchParams.has('item')) return;
	// pushState removes the forward destination; the next open replaces this slot.
	history.pushState({ readingLibrary: true, readingStackId: stackId, readingSection: entry.readingSection }, '', location.href);
}
