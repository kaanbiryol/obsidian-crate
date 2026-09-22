import type { ReadingItem } from '../core/model';

export type ReadingSection = 'inbox' | 'favorites' | 'archived';
export const readingSections = [
	{ id: 'inbox', label: 'Inbox' }, { id: 'favorites', label: 'Favorites' }, { id: 'archived', label: 'Archive' },
] as const;

export function readingSource(url: string): string { return new URL(url).hostname.replace(/^www\./, ''); }

export function filterReadingItems(items: ReadingItem[], section: ReadingSection, query: string, tag: string | null): ReadingItem[] {
	const search = query.trim().toLocaleLowerCase();
	return items.filter(item => (section === 'favorites' ? item.favorite : item.reading_status === section)
		&& (!tag || item.tags.includes(tag))
		&& `${item.title} ${item.source_url} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(search))
		.sort((a, b) => b.saved_at.localeCompare(a.saved_at) || a.crate_reading_id.localeCompare(b.crate_reading_id));
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
