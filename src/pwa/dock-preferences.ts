export const DEFAULT_DOCK_TABS = ['inbox', 'today', 'browse', 'reading'] as const;
// Keep the existing 'today' preference for Schedule; 'today-view' pins Today directly.
export const DOCK_TABS = [
	{ id: 'inbox', label: 'Inbox', iconName: 'inbox' },
	{ id: 'today', label: 'Schedule', iconName: 'calendar' },
	{ id: 'today-view', label: 'Today', iconName: 'calendar-check' },
	{ id: 'upcoming', label: 'Upcoming', iconName: 'calendar-range' },
	{ id: 'browse', label: 'Projects', iconName: 'folder-open' },
	{ id: 'reading', label: 'Reading list', iconName: 'book-open' },
	{ id: 'favorites', label: 'Favorites', iconName: 'star' },
	{ id: 'archive', label: 'Archive', iconName: 'archive' },
	{ id: 'highlights', label: 'Highlights', iconName: 'highlighter' },
] as const;
export type DockTab = typeof DOCK_TABS[number]['id'];

/** Also embedded in the early HTML bootstrap; keep these functions self-contained. */
export function normalizeDockTabs(value: unknown): DockTab[] {
	const defaults: DockTab[] = ['inbox', 'today', 'browse', 'reading'];
	const allowed = ['inbox', 'today', 'today-view', 'upcoming', 'browse', 'reading', 'favorites', 'archive', 'highlights'];
	if (!Array.isArray(value)) return defaults;
	const tabs = [...new Set(value.filter((tab): tab is DockTab => allowed.includes(tab as string)))].slice(0, 4);
	return [...tabs, ...defaults.filter(tab => !tabs.includes(tab))].slice(0, 4);
}

export function dockDestinationIndex(tabs: readonly DockTab[], section: string, tab: string): number {
	if (section === 'reminders' && tab === 'today' && tabs.includes('today-view')) return tabs.indexOf('today-view');
	const id = section === 'reading' ? tab === 'inbox' ? 'reading' : tab === 'archived' ? 'archive' : tab : tab;
	const index = tabs.indexOf(id as DockTab);
	if (index >= 0) return index;
	return section === 'reading' ? tabs.indexOf('reading') : tab === 'upcoming' ? tabs.indexOf('today') : -1;
}

/** CSS variables let cached launch chrome use the same layout before React loads. */
export function applyOpeningDockPreferences(tabs: readonly DockTab[]): void {
	const root = document.documentElement;
	root.style.setProperty('--pwa-dock-count', String(tabs.length));
	for (const tab of ['inbox', 'today', 'today-view', 'upcoming', 'browse', 'reading', 'favorites', 'archive', 'highlights']) {
		const index = tabs.indexOf(tab as DockTab);
		root.style.setProperty(`--pwa-dock-${tab}-order`, String(index));
		root.style.setProperty(`--pwa-dock-${tab}-hint`, index === tabs.length - 1 ? 'flex' : 'none');
		root.style.setProperty(`--pwa-dock-${tab}-display`, index < 0 ? 'none' : 'flex');
		root.style.setProperty(`--pwa-dock-${tab}-indicator`, index < 0 ? '0' : '1');
		const fallback = tab === 'today' && tabs.includes('today-view') ? tabs.indexOf('today-view') : index >= 0 ? index : ['favorites', 'archive', 'highlights'].includes(tab) ? tabs.indexOf('reading') : tab === 'upcoming' ? tabs.indexOf('today') : -1;
		root.style.setProperty(`--pwa-dock-${tab}-active-order`, String(fallback));
		root.style.setProperty(`--pwa-dock-${tab}-active-indicator`, fallback < 0 ? '0' : '1');
	}
}
