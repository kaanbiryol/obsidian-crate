import { normalizeDockTabs, applyOpeningDockPreferences, dockDestinationIndex } from './dock-preferences';
import { PWA_PREFERENCES_KEY } from './preferences';
import { resolvePwaOpeningDestination } from './opening-destination';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import type { StartTab } from './types';

// Static, build-owned chrome for the HTML shell and React loading screens.
// The SVG paths match the Lucide icons in PwaDock; browser coverage compares
// their rendered geometry with the interactive dock at the loading handoff.
export const openingIconSvg = (name: string, paths: string, extra = '', size = 20) => `<svg data-icon="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
const svg = openingIconSvg;
const icons = {
	inbox: svg('inbox', '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
	today: svg('calendar', '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
	browse: svg('folder-open', '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
	favorites: svg('star', '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>'),
	archive: svg('archive', '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
	highlights: svg('highlighter', '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
	reading: svg('book-open', '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>'),
};

export function createPwaOpeningDockHtml(tab?: StartTab | 'reading', readingTab: ReadingSection = 'inbox'): string {
	// A cached HTML shell cannot embed request-specific state. Its selection
	// comes from the early bootstrap; React can override it once enrollment resolves.
	const active = tab === 'reading' ? readingTab === 'inbox' ? 'reading' : readingTab === 'archived' ? 'archive' : readingTab : tab === 'upcoming' ? 'today' : tab;
	const index = tab ? ['inbox', 'today', 'browse', 'reading'].indexOf(tab === 'upcoming' ? 'today' : tab) : null;
	return `<div class="crate-reminders-ui pwa-opening-dock"${tab ? ` data-opening-tab="${tab}" data-opening-selection="${active}" style="--pwa-opening-dock-index:var(--pwa-dock-${active}-active-order,${index});--pwa-opening-dock-indicator:var(--pwa-dock-${active}-active-indicator,${index === -1 ? 0 : 1})"` : ''} aria-hidden="true" inert>
		<div class="pwa-dock pwa-dock--opening"><nav class="pwa-dock__bar">
			<span class="pwa-dock__surface"></span><span class="pwa-dock__indicator"></span>
			${Object.entries(icons).map(([id, icon]) => `<span class="pwa-dock__tab" data-opening-destination="${id}">${icon}<span class="pwa-dock__group-hint">${svg('chevrons-up-down', '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>', 'style="stroke-width:1.8"', 12)}</span></span>`).join('')}
		</nav><span class="pwa-dock__add">${svg('plus', '<path d="M5 12h14"/><path d="M12 5v14"/>')}</span></div>
	</div>`;
}

// This also runs for a service-worker shell whose HTML URL has no launch params.
export const PWA_OPENING_DOCK_INIT_JS = `(()=>{let saved;try{saved=JSON.parse(localStorage.getItem(${JSON.stringify(PWA_PREFERENCES_KEY)})||'null')}catch{}const destination=(${resolvePwaOpeningDestination.toString()})(location.search,saved?.defaultScreen);const {tab,title,project}=destination;const root=document.documentElement;const tabs=(${normalizeDockTabs.toString()})(saved?.dockTabs);(${applyOpeningDockPreferences.toString()})(tabs);const index=(${dockDestinationIndex.toString()})(tabs,tab==='reading'?'reading':'reminders',tab==='reading'?destination.readingTab:tab);root.dataset.pwaOpeningTab=tab;root.dataset.pwaOpeningDockTab=tabs[index]||'';root.dataset.pwaOpeningTitle=title;root.dataset.pwaOpeningProject=project||'';root.style.setProperty('--pwa-opening-dock-index',String(index));root.style.setProperty('--pwa-opening-dock-indicator',index<0?'0':'1')})();`;
