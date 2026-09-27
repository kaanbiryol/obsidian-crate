export const DEFAULT_DOCK_TABS = ['inbox', 'today', 'browse', 'reading'] as const;
export type DockTab = typeof DEFAULT_DOCK_TABS[number];

/** Also embedded in the early HTML bootstrap; keep this function self-contained. */
export function normalizeDockTabs(value: unknown): DockTab[] {
	const defaults: DockTab[] = ['inbox', 'today', 'browse', 'reading'];
	if (!Array.isArray(value)) return defaults;
	const tabs = defaults.filter(tab => value.includes(tab));
	return tabs.length ? [...new Set(value.filter((tab): tab is DockTab => defaults.includes(tab as DockTab)))] : defaults;
}

/** CSS variables let cached launch chrome use the same layout before React loads. */
export function applyOpeningDockPreferences(tabs: readonly DockTab[]): void {
	const root = document.documentElement;
	root.style.setProperty('--pwa-dock-count', String(tabs.length));
	for (const tab of ['inbox', 'today', 'browse', 'reading']) {
		const index = tabs.indexOf(tab as DockTab);
		root.style.setProperty(`--pwa-dock-${tab}-order`, String(index));
		root.style.setProperty(`--pwa-dock-${tab}-display`, index < 0 ? 'none' : 'flex');
		root.style.setProperty(`--pwa-dock-${tab}-indicator`, index < 0 ? '0' : '1');
	}
}
