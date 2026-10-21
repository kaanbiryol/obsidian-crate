import type { DockTab } from '@/ui/shared/navigation/dock-destinations';
export { DEFAULT_DOCK_TABS, DOCK_TABS, normalizeDockTabs, dockDestinationIndex, type DockTab } from '@/ui/shared/navigation/dock-destinations';

/** CSS variables let cached launch chrome use the same layout before React loads. */
export function applyOpeningDockPreferences(tabs: readonly DockTab[]): void {
	const root = document.documentElement;
	root.style.setProperty('--pwa-dock-count', String(tabs.length));
	for (const tab of ['inbox', 'today', 'browse', 'reading', 'favorites', 'archive', 'highlights']) {
		const index = tabs.indexOf(tab as DockTab);
		root.style.setProperty(`--pwa-dock-${tab}-order`, String(index));
		root.style.setProperty(`--pwa-dock-${tab}-hint`, index === tabs.length - 1 ? 'flex' : 'none');
		root.style.setProperty(`--pwa-dock-${tab}-display`, index < 0 ? 'none' : 'flex');
		root.style.setProperty(`--pwa-dock-${tab}-indicator`, index < 0 ? '0' : '1');
		const fallback = index;
		root.style.setProperty(`--pwa-dock-${tab}-active-order`, String(fallback));
		root.style.setProperty(`--pwa-dock-${tab}-active-indicator`, fallback < 0 ? '0' : '1');
	}
}
