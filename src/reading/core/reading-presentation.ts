import type { ReadingItem } from './model';
import { youtubeVideoId } from './youtube';
import { highlightedAt, highlightMatches } from './search-terms';

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

/** A tag in the filter, with how many of the section's notes have it. */
export interface ReadingTag { name: string; count: number }

/** Most used first, then by name. */
function rankReadingTags(tags: ReadingTag[]): ReadingTag[] {
	return [...tags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The tags of a section's notes, counted from a library held in memory. */
export function countReadingTags(items: ReadingItem[], section: ReadingSection): ReadingTag[] {
	const counts = new Map<string, number>();
	for (const item of filterReadingItems(items, section, '', null)) for (const tag of new Set(item.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	return rankReadingTags([...counts].map(([name, count]) => ({ name, count })));
}

export function groupReadingItems(items: ReadingItem[], now = new Date()): { label: string; items: ReadingItem[] }[] {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
	const groups = new Map<string, ReadingItem[]>();
	// Formatting a date costs about 30 µs, so each month's label is formatted once, not per row.
	const months = new Map<number, string>();
	for (const item of items) {
		const saved = new Date(item.saved_at), month = saved.getFullYear() * 12 + saved.getMonth();
		const label = saved >= today ? 'Today' : saved >= yesterday ? 'Yesterday'
			: months.get(month) ?? months.set(month, saved.toLocaleDateString(undefined, { month: 'long', ...(saved.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })).get(month)!;
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

/** A server library pages notes by their newest highlight, so a later page can hold highlights
 * older than ones already shown. While pages remain, only rows from the oldest loaded note's
 * newest highlight onward are final, so later pages append below them instead of between them. */
export function settledHighlights<Row extends { item: ReadingItem; highlight: { createdAt?: string } }>(rows: Row[], loaded: ReadingItem[]): Row[] {
	const frontier = loaded.reduce<string | null>((oldest, item) => {
		const at = highlightedAt(item);
		return at !== null && (oldest === null || at.localeCompare(oldest) < 0) ? at : oldest;
	}, null);
	return frontier === null ? rows : rows.filter(({ item, highlight }) => (highlight.createdAt ?? item.saved_at).localeCompare(frontier) >= 0);
}
