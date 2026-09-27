import { SPINNER_SPOKES_HTML } from '../ui/shared/spinner-spokes';
import { createPwaOpeningDockHtml, openingIconSvg } from './opening-dock';
import type { resolvePwaOpeningDestination } from './opening-destination';

// Match the shared React loading indicator before the app module is available.
const loadingIndicator = (label: string) => `<div class="crate-content-loading" role="status" aria-label="${label}"><svg class="crate-content-loading__spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">${SPINNER_SPOKES_HTML}</svg></div>`;

const settings = openingIconSvg('settings', '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>');
const iconButton = (icon: string, className = '') => `<span class="crate-icon-button ${className}" data-size="large" aria-hidden="true">${icon}</span>`;
const sync = `<span class="pwa-sync-indicator" aria-hidden="true"><span class="pwa-sync-indicator__button"><span class="crate-sync-indicator" data-sync-state="syncing" data-visual-state="syncing"><span class="crate-sync-indicator__halo"></span><span class="crate-sync-indicator__dot"></span><span class="crate-sync-indicator__ripple"></span></span></span></span>`;

function header(reading = false) {
	return `<div class="view-header${reading ? ' crate-reading__header pwa-reading-opening__header' : ''}">
		<div class="view-header-copy"><div class="view-header-title-row"><h1 class="view-header-title" data-pwa-launch-title>Reminders</h1></div><div class="view-header-meta is-reserved" aria-hidden="true"></div></div>
		<div class="view-header-actions"><div class="crate-view-header-actions">${reading ? '<span class="pwa-reading-opening__sync" aria-hidden="true"></span>' : sync}${iconButton(settings, reading ? '' : 'pwa-header-settings-button')}${reading ? iconButton(openingIconSvg('list-todo', '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4M13 6h8M13 10h8M13 16h8M13 20h8"/>'), 'pwa-feature-switch-button') : ''}</div></div>
	</div>`;
}

function scheduleChips(tab = 'today') {
	if (tab !== 'today' && tab !== 'upcoming') return '';
	return `<div class="pwa-schedule-switcher" data-value="${tab}" data-pwa-opening-schedule aria-hidden="true" inert><div class="pwa-schedule-control">${['today', 'upcoming'].map(view => `<button type="button" class="pwa-schedule-chip" aria-pressed="${tab === view}" data-schedule-option="${view}" tabindex="-1">${view === 'today' ? 'Today' : 'Upcoming'}</button>`).join('')}</div></div>`;
}

const reminders = `<div class="crate-reminders-ui reminders-shadow-root pwa-shadow-root" data-pwa-static-shell><main class="pwa-screen reminders-view is-primary pwa-mode-opening pwa-opening-screen">
	${header()}${scheduleChips()}<div class="reminders-content">${loadingIndicator('Loading reminders')}</div>${createPwaOpeningDockHtml()}
</main></div>`;
const reading = `<div class="crate-reminders-ui pwa-reading-root" data-pwa-static-shell><main class="pwa-screen crate-reading-web pwa-mode-opening pwa-reading-opening">
	${header(true)}<div class="pwa-reading-opening__search" aria-hidden="true"></div>
	<div class="pwa-mode-opening__content">${loadingIndicator('Loading Reading')}</div>${createPwaOpeningDockHtml()}
</main></div>`;

const project = `<div class="crate-reminders-ui reminders-shadow-root pwa-shadow-root" data-pwa-static-shell><main class="pwa-screen reminders-view is-primary is-modal is-fullscreen pwa-mode-opening pwa-opening-screen is-project-detail">
	<div class="pwa-project-layer" data-project-open="true"><div class="pwa-navigation-screen pwa-navigation-screen--project">
		<div class="reminders-content"><div class="flex flex-col h-full relative min-h-0">
			<div class="project-detail-navigation"><span class="premium-back-button" aria-hidden="true">${openingIconSvg('chevron-left', '<path d="m15 18-6-6 6-6"/>')}<span>Back</span></span><div class="crate-view-header-actions">${sync}</div></div>
			<div class="project-detail-header"><div class="project-detail-header-top"><div class="project-detail-title-row"><h1 class="project-detail-title" data-pwa-launch-title>Reminders</h1></div></div></div>
			<div class="flex-1 min-h-0 overflow-y-auto ios-scroll reminders-view-scroll has-fab">${loadingIndicator('Loading reminders')}</div>
		</div></div>
		<span class="reminders-fab fab pwa-project-fab" aria-hidden="true">${openingIconSvg('plus', '<path d="M5 12h14"/><path d="M12 5v14"/>')}</span>
	</div></div>
</main></div>`;

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createPwaOpeningScreenHtml(destination?: ReturnType<typeof resolvePwaOpeningDestination>): string {
	if (!destination) return reminders;
	return (destination.tab === 'reading' ? reading : destination.project ? project : reminders)
		.replace(scheduleChips(), scheduleChips(destination.tab))
		.replace('data-pwa-launch-title>Reminders', () => `data-pwa-launch-title>${escapeText(destination.title)}`)
		.replace(createPwaOpeningDockHtml(), createPwaOpeningDockHtml(destination.tab, destination.tab === 'reading' ? destination.readingTab : undefined));
}

// The service worker caches generic HTML. Resolve this launch's labels before
// the parser reaches the app module, without waiting for any network request.
export const PWA_OPENING_SCREEN_INIT_JS = `(()=>{const root=document.documentElement;const splash=document.querySelector('.pwa-launch-splash');if(!splash)return;if(root.dataset.pwaOpeningTab==='reading')splash.innerHTML=${JSON.stringify(reading)};else if(root.dataset.pwaOpeningProject)splash.innerHTML=${JSON.stringify(project)};const title=splash.querySelector('[data-pwa-launch-title]');if(title)title.textContent=root.dataset.pwaOpeningTitle||'Reminders';const chips=splash.querySelector('[data-pwa-opening-schedule]');if(chips){const tab=root.dataset.pwaOpeningTab||'today';chips.hidden=tab!=='today'&&tab!=='upcoming';chips.dataset.value=tab;for(const chip of chips.querySelectorAll('[data-schedule-option]'))chip.setAttribute('aria-pressed',String(chip.dataset.scheduleOption===tab))}})();`;
