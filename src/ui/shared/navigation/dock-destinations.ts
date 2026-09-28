export const DEFAULT_DOCK_TABS = ['inbox', 'today', 'browse', 'reading'] as const;
// Keep the existing 'today' preference for the parent Reminders tab.
export const DOCK_TABS = [
	{ id: 'inbox', label: 'Inbox', iconName: 'inbox' },
	{ id: 'today', label: 'Reminders', iconName: 'calendar' },
	{ id: 'browse', label: 'Projects', iconName: 'folder-open' },
	{ id: 'reading', label: 'Reading', iconName: 'book-open' },
	{ id: 'favorites', label: 'Favorites', iconName: 'star' },
	{ id: 'archive', label: 'Archive', iconName: 'archive' },
	{ id: 'highlights', label: 'Highlights', iconName: 'highlighter' },
] as const;
export type DockTab = typeof DOCK_TABS[number]['id'];

/** Also embedded in the early HTML bootstrap; keep these functions self-contained. */
export function normalizeDockTabs(value: unknown): DockTab[] {
	const defaults: DockTab[] = ['inbox', 'today', 'browse', 'reading'];
	const allowed = ['inbox', 'today', 'browse', 'reading', 'favorites', 'archive', 'highlights'];
	if (!Array.isArray(value)) return defaults;
	// Migrate former date-view slots to their parent before deduplicating.
	const migrated = value.map((tab: unknown) => tab === 'today-view' || tab === 'upcoming' ? 'today' : tab);
	const tabs = [...new Set(migrated.filter((tab): tab is DockTab => allowed.includes(tab as string)))].slice(0, 4);
	return [...tabs, ...defaults.filter(tab => !tabs.includes(tab))].slice(0, 4);
}

export function dockDestinationIndex(tabs: readonly DockTab[], section: string, tab: string): number {
	const id = section === 'reading' ? tab === 'inbox' ? 'reading' : tab === 'archived' ? 'archive' : tab : tab === 'upcoming' ? 'today' : tab;
	const index = tabs.indexOf(id as DockTab);
	if (index >= 0) return index;
	return -1;
}
