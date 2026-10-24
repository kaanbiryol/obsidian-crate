import { normalizeDockTabs, applyOpeningDockPreferences, dockDestinationIndex } from '../settings/dock-preferences';
import { TABLER_ICONS } from '@/ui/shared/icons/tabler-icons.generated';
import { PWA_PREFERENCES_KEY } from '../settings/preferences';
import { resolvePwaOpeningDestination } from '../navigation/opening-destination';
import type { ReadingSection } from '@/reading/core/reading-presentation';
import type { StartTab } from '../types';

// Static, build-owned chrome for the HTML shell and React loading screens.
// The SVG paths come from the same Tabler map as PwaDock; browser coverage compares
// their rendered geometry with the interactive dock at the loading handoff.
export const openingIconSvg = (name: string, paths: string, extra = '', size = 20) => `<svg data-icon="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
export const tablerSvg = (name: string, extra = '', size = 20) => openingIconSvg(name, TABLER_ICONS[name] ?? '', extra, size);
const icons = {
	inbox: tablerSvg('inbox'),
	today: tablerSvg('circle-check'),
	browse: tablerSvg('folder-open'),
	favorites: tablerSvg('star'),
	archive: tablerSvg('archive'),
	highlights: tablerSvg('highlighter'),
	reading: tablerSvg('book-open'),
};

export function createPwaOpeningDockHtml(tab?: StartTab | 'reading', readingTab: ReadingSection = 'inbox'): string {
	// A cached HTML shell cannot embed request-specific state. Its selection
	// comes from the early bootstrap; React can override it once enrollment resolves.
	const active = tab === 'reading' ? readingTab === 'inbox' ? 'reading' : readingTab === 'archived' ? 'archive' : readingTab : tab === 'upcoming' ? 'today' : tab;
	const index = tab ? ['inbox', 'today', 'browse', 'reading'].indexOf(tab === 'upcoming' ? 'today' : tab) : null;
	return `<div class="crate-reminders-ui pwa-opening-dock"${tab ? ` data-opening-tab="${tab}" data-opening-selection="${active}" style="--pwa-opening-dock-index:var(--pwa-dock-${active}-active-order,${index});--pwa-opening-dock-indicator:var(--pwa-dock-${active}-active-indicator,${index === -1 ? 0 : 1})"` : ''} aria-hidden="true" inert>
		<div class="pwa-dock pwa-dock--opening"><nav class="pwa-dock__bar">
			<span class="pwa-dock__surface"></span><span class="pwa-dock__indicator"></span>
			${Object.entries(icons).map(([id, icon]) => `<span class="pwa-dock__tab" data-opening-destination="${id}">${icon}<span class="pwa-dock__group-hint">${tablerSvg('chevrons-up-down', 'style="stroke-width:1.8"', 12)}</span></span>`).join('')}
		</nav><span class="pwa-dock__add">${tablerSvg('plus')}</span></div>
	</div>`;
}

// This also runs for a service-worker shell whose HTML URL has no launch params.
export const PWA_OPENING_DOCK_INIT_JS = `(()=>{let saved;try{saved=JSON.parse(localStorage.getItem(${JSON.stringify(PWA_PREFERENCES_KEY)})||'null')}catch{}const destination=(${resolvePwaOpeningDestination.toString()})(location.search,saved?.defaultScreen);const {tab,title,project}=destination;const root=document.documentElement;const tabs=(${normalizeDockTabs.toString()})(saved?.dockTabs);(${applyOpeningDockPreferences.toString()})(tabs);const index=(${dockDestinationIndex.toString()})(tabs,tab==='reading'?'reading':'reminders',tab==='reading'?destination.readingTab:tab);root.dataset.pwaOpeningTab=tab;root.dataset.pwaOpeningDockTab=tabs[index]||'';root.dataset.pwaOpeningTitle=title;root.dataset.pwaOpeningProject=project||'';root.style.setProperty('--pwa-opening-dock-index',String(index));root.style.setProperty('--pwa-opening-dock-indicator',index<0?'0':'1')})();`;
