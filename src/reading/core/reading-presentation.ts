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

/** Whether a note belongs to a section, the way the server's section filters list it. */
export const inReadingSection = (section: ReadingSection, item: ReadingItem) =>
	section === 'highlights' ? !!item.highlights?.length : section === 'favorites' ? item.favorite : item.reading_status === section;

export function filterReadingItems(items: ReadingItem[], section: ReadingSection, query: string, tag: string | null): ReadingItem[] {
	const search = query.trim().toLocaleLowerCase();
	// Without a search, no note's text is built: a library update lists every section this way.
	const filtered = items.filter(item => inReadingSection(section, item) && (!tag || item.tags.includes(tag))
		&& (!search || `${item.title} ${item.author ?? ''} ${item.source_url} ${item.tags.join(' ')} ${section === 'highlights' ? item.highlights?.map(entry => `${entry.text} ${entry.note ?? ''}`).join(' ') : ''}`.toLocaleLowerCase().includes(search)));
	// The plugin's library is already in this order; checking it is cheaper than sorting on every keystroke.
	return filtered.every((item, index) => index === 0 || newestFirst(filtered[index - 1]!, item) <= 0) ? filtered : filtered.sort(newestFirst);
}

/** A tag in the filter, with how many of the section's notes have it. */
export interface ReadingTag { name: string; count: number }

/** Most used first, then by name. */
export function rankReadingTags(tags: ReadingTag[]): ReadingTag[] {
	return [...tags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The tags of a section's notes, counted from a library held in memory. */
export function countReadingTags(items: ReadingItem[], section: ReadingSection): ReadingTag[] {
	const counts = new Map<string, number>();
	for (const item of items) if (inReadingSection(section, item)) for (const tag of new Set(item.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
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

type HighlightRow = { item: ReadingItem; highlight: NonNullable<ReadingItem['highlights']>[number] };
// Notes are replaced, never changed, so a note's rows and a list's sorted rows are kept by identity.
const itemRows = new WeakMap<ReadingItem, { rows: HighlightRow[]; at: string[] }>();
const sortedRows = new WeakMap<ReadingItem[], HighlightRow[]>();
const rowText = new WeakMap<HighlightRow, string>();
function highlightRows(item: ReadingItem) {
	let entry = itemRows.get(item);
	if (!entry) {
		const highlights = item.highlights ?? [];
		entry = { rows: highlights.map(highlight => ({ item, highlight })), at: highlights.map(highlight => highlight.createdAt ?? item.saved_at) };
		itemRows.set(item, entry);
	}
	return entry;
}
/** Every highlight of `items`, newest first, sorted once per list. Timestamps and IDs compare
 * by code unit, as the server orders them. */
function sortedHighlightRows(items: ReadingItem[]): HighlightRow[] {
	let rows = sortedRows.get(items);
	if (rows) return rows;
	const keyed: { row: HighlightRow; at: string }[] = [];
	for (const item of items) { const { rows: own, at } = highlightRows(item); own.forEach((row, index) => keyed.push({ row, at: at[index]! })); }
	keyed.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1
		: a.row.item.crate_reading_id < b.row.item.crate_reading_id ? -1 : a.row.item.crate_reading_id > b.row.item.crate_reading_id ? 1
			: a.row.highlight.start - b.row.highlight.start);
	rows = keyed.map(entry => entry.row);
	sortedRows.set(items, rows);
	return rows;
}
const searchText = (row: HighlightRow) => {
	let text = rowText.get(row);
	if (text === undefined) {
		const { item, highlight } = row;
		text = `${item.title} ${item.author ?? ''} ${item.source_url} ${item.tags.join(' ')} ${highlight.text} ${highlight.note ?? ''}`.toLocaleLowerCase();
		rowText.set(row, text);
	}
	return text;
};

/** Each highlight of `items` that matches `query`, newest first. `byWords` matches the way a
 * server library does: `items` already matched, so a highlight matches when every query word
 * starts a word of it or its title, and a note whose words span its highlights shows them all.
 * `all`, a list that holds `items` and keeps its identity while the query changes, is sorted
 * once instead of on every keystroke. */
export function filterReadingHighlights(items: ReadingItem[], query: string, byWords = false, all: ReadingItem[] = items): HighlightRow[] {
	const search = query.trim().toLocaleLowerCase();
	let rows = sortedHighlightRows(all);
	if (all !== items) { const listed = new Set(items); rows = rows.filter(row => listed.has(row.item)); }
	if (!search) return rows;
	if (!byWords) return rows.filter(row => searchText(row).includes(search));
	const matching = new Map<ReadingItem, Set<HighlightRow['highlight']>>();
	return rows.filter(({ item, highlight }) => {
		let matched = matching.get(item);
		if (!matched) matching.set(item, matched = new Set((item.highlights ?? []).filter(entry => highlightMatches(item.title, entry, query))));
		return !matched.size || matched.has(highlight);
	});
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
