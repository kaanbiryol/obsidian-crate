import type { ReadingItem } from './model';
import { youtubeVideoId } from './youtube';
import { highlightMatches } from './search-terms';

export type ReadingSection = 'inbox' | 'favorites' | 'archived' | 'highlights';
export const readingSections = [
	{ id: 'inbox', label: 'Inbox' }, { id: 'favorites', label: 'Favorites' }, { id: 'archived', label: 'Archive' },
	{ id: 'highlights', label: 'Highlights' },
] as const;

export function readingSource(url: string): string { return url ? new URL(url).hostname.replace(/^www\./, '') : 'Vault note'; }

export function readingTitle(item: Pick<ReadingItem, 'title' | 'source_url'>): string {
	return youtubeVideoId(item.source_url) && item.title === new URL(item.source_url).hostname ? 'YouTube video' : item.title;
}

const newestFirst = (a: ReadingItem, b: ReadingItem) => b.saved_at.localeCompare(a.saved_at) || a.crate_reading_id.localeCompare(b.crate_reading_id);

export function filterReadingItems(items: ReadingItem[], section: ReadingSection, query: string, tag: string | null): ReadingItem[] {
	const search = query.trim().toLocaleLowerCase();
	const filtered = items.filter(item => (section === 'highlights' ? !!item.highlights?.length : section === 'favorites' ? item.favorite : item.reading_status === section)
		&& (!tag || item.tags.includes(tag))
		&& `${item.title} ${item.author ?? ''} ${item.source_url} ${item.tags.join(' ')} ${section === 'highlights' ? item.highlights?.map(entry => `${entry.text} ${entry.note ?? ''}`).join(' ') : ''}`.toLocaleLowerCase().includes(search));
	// The plugin's library is already in this order; checking it is cheaper than sorting on every keystroke.
	return filtered.every((item, index) => index === 0 || newestFirst(filtered[index - 1]!, item) <= 0) ? filtered : filtered.sort(newestFirst);
}

export function groupReadingItems(items: ReadingItem[], now = new Date()): { label: string; items: ReadingItem[] }[] {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
	const groups = new Map<string, ReadingItem[]>();
	for (const item of items) {
		const saved = new Date(item.saved_at);
		const label = saved >= today ? 'Today' : saved >= yesterday ? 'Yesterday'
			: saved.toLocaleDateString(undefined, { month: 'long', ...(saved.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
		const group = groups.get(label) ?? []; group.push(item); groups.set(label, group);
	}
	return Array.from(groups, ([label, items]) => ({ label, items }));
}

/** Each highlight of `items` that matches `query`, newest first. `byWords` matches the way a
 * server library does: `items` already matched, so a highlight matches when every query word
 * starts a word of it or its title, and a note whose words span its highlights shows them all. */
export function filterReadingHighlights(items: ReadingItem[], query: string, byWords = false) {
	const search = query.trim().toLocaleLowerCase();
	return items.flatMap(item => {
		const highlights = item.highlights ?? [];
		if (!byWords) return highlights.filter(highlight => `${item.title} ${item.author ?? ''} ${item.source_url} ${item.tags.join(' ')} ${highlight.text} ${highlight.note ?? ''}`.toLocaleLowerCase().includes(search))
			.map(highlight => ({ item, highlight }));
		const matching = search ? highlights.filter(highlight => highlightMatches(item.title, highlight, query)) : highlights;
		return (matching.length ? matching : highlights).map(highlight => ({ item, highlight }));
	})
		.sort((a, b) => (b.highlight.createdAt ?? b.item.saved_at).localeCompare(a.highlight.createdAt ?? a.item.saved_at)
			|| a.item.crate_reading_id.localeCompare(b.item.crate_reading_id) || a.highlight.start - b.highlight.start);
}
