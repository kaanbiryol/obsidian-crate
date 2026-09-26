import { PWA_PREFERENCES_KEY } from './preferences';
import type { StartTab } from './types';

// Static, build-owned chrome for the HTML shell and React loading screens.
// The SVG paths match the Lucide icons in PwaDock; browser coverage compares
// their rendered geometry with the interactive dock at the loading handoff.
const svg = (name: string, paths: string, extra = '', size = 20) => `<svg data-icon="${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
const icons = {
	inbox: svg('inbox', '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
	today: svg('calendar', '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
	browse: svg('folder-open', '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'),
	reading: svg('book-open', '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>')
		+ svg('chevrons-up-down', '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>', 'class="pwa-dock__group-hint"', 12),
};

export function createPwaOpeningDockHtml(tab?: StartTab | 'reading'): string {
	// A cached HTML shell cannot embed request-specific state. Its selection
	// comes from the early bootstrap; React can override it once enrollment resolves.
	const index = tab ? ['inbox', 'today', 'browse', 'reading'].indexOf(tab) : null;
	return `<div class="crate-reminders-ui pwa-opening-dock"${tab ? ` data-opening-tab="${tab}" style="--pwa-opening-dock-index:${index};--pwa-opening-dock-indicator:${index === -1 ? 0 : 1}"` : ''} aria-hidden="true" inert>
		<div class="pwa-dock pwa-dock--opening"><nav class="pwa-dock__bar">
			<span class="pwa-dock__surface"></span><span class="pwa-dock__indicator"></span>
			${Object.entries(icons).map(([id, icon]) => `<span class="pwa-dock__tab${id === 'reading' ? ' pwa-dock__group' : ''}" data-opening-destination="${id}">${icon}</span>`).join('')}
		</nav><span class="pwa-dock__add">${svg('plus', '<path d="M5 12h14"/><path d="M12 5v14"/>')}</span></div>
	</div>`;
}

// This also runs for a service-worker shell whose HTML URL has no launch params.
export const PWA_OPENING_DOCK_INIT_JS = `(()=>{let tab='today';try{const saved=JSON.parse(localStorage.getItem(${JSON.stringify(PWA_PREFERENCES_KEY)})||'null');if(['inbox','today','upcoming','browse'].includes(saved?.defaultScreen))tab=saved.defaultScreen}catch{}const params=new URLSearchParams(location.search);if(['inbox','today','upcoming','browse'].includes(params.get('tab')))tab=params.get('tab');if(params.get('project'))tab='browse';if(params.get('section')==='reading')tab='reading';const root=document.documentElement;const index=['inbox','today','browse','reading'].indexOf(tab);root.dataset.pwaOpeningTab=tab;root.style.setProperty('--pwa-opening-dock-index',String(index));root.style.setProperty('--pwa-opening-dock-indicator',index<0?'0':'1')})();`;
