import { Script } from 'node:vm';
import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';
import { PWA_OPENING_DOCK_INIT_JS } from './opening-dock';
import { resolvePwaOpeningDestination } from './opening-destination';
import { createPwaOpeningScreenHtml, PWA_OPENING_SCREEN_INIT_JS } from './opening-screen';

it.each([
	['', null, 'Reminders', 'today'],
	['', '{"defaultScreen":"reading"}', 'Reading', 'reading'],
	['', '{"defaultScreen":"favorites"}', 'Favorites', 'reading'],
	['', '{"defaultScreen":"archive"}', 'Archive', 'reading'],
	['?reminderId=notification', '{"defaultScreen":"reading"}', 'Reminders', 'today'],
	['?tab=inbox', '{"defaultScreen":"favorites"}', 'Inbox', 'inbox'],
	['?browserToken=enrollment', '{"defaultScreen":"reading"}', 'Reminders', 'today'],
	['', '{"defaultScreen":"browse"}', 'Projects', 'browse'],
	['?tab=inbox', '{"defaultScreen":"browse"}', 'Inbox', 'inbox'],
	['?tab=upcoming', null, 'Reminders', 'upcoming'],
	['?project=%3Cwork%3E%20%26%20home&tab=inbox', null, '<work> & home', 'browse'],
	['?section=reading&project=Work', null, 'Reading', 'reading'],
	['?tab=invalid', 'broken json', 'Reminders', 'today'],
])('paints the complete cached shell before app.js: %s', (search, saved, title, tab) => {
	const { document } = parseHTML(`<html><body><div class="pwa-launch-splash">${createPwaOpeningScreenHtml()}</div></body></html>`);
	new Script(PWA_OPENING_DOCK_INIT_JS + PWA_OPENING_SCREEN_INIT_JS).runInNewContext({
		document, URLSearchParams, location: { search }, localStorage: { getItem: () => saved },
	});
	expect(document.querySelector('h1')?.textContent).toBe(title);
	expect(document.documentElement.dataset.pwaOpeningTab).toBe(tab);
	const chips = document.querySelector('[data-pwa-opening-schedule]');
	if (tab === 'today' || tab === 'upcoming') {
		expect(chips?.querySelector('[aria-pressed="true"]')?.textContent).toBe(tab === 'today' ? 'Today' : 'Upcoming');
	} else {
		expect(!chips || chips.hasAttribute('hidden')).toBe(true);
	}
	const isProject = Boolean(document.documentElement.dataset.pwaOpeningProject);
	expect(document.querySelectorAll('[data-icon="settings"]')).toHaveLength(isProject ? 0 : 1);
	expect(document.querySelectorAll('.pwa-dock__tab > svg, .pwa-dock__add > svg')).toHaveLength(isProject ? 0 : 8);
	expect(document.querySelectorAll('.crate-content-loading')).toHaveLength(1);
	expect(document.querySelector('work')).toBeNull();
});

it('escapes a project title in the React bootstrap shell', () => {
	const destination = resolvePwaOpeningDestination('?project=%3Cimg%20src=x%20onerror=alert(1)%3E%26%24%26');
	const { document } = parseHTML(createPwaOpeningScreenHtml(destination));
	expect(document.querySelector('h1')?.textContent).toBe('<img src=x onerror=alert(1)>&$&');
	expect(document.querySelector('img')).toBeNull();
});

it('applies custom dock order and visibility before React starts, including hidden launch targets', () => {
  const { document } = parseHTML('<html><body></body></html>');
  new Script(PWA_OPENING_DOCK_INIT_JS).runInNewContext({
    document, URLSearchParams, location: { search: '?tab=today' },
    localStorage: { getItem: () => JSON.stringify({ dockTabs: ['reading', 'inbox', 'archive', 'highlights'] }) },
  });
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--pwa-dock-count')).toBe('4');
  expect(style.getPropertyValue('--pwa-dock-reading-order')).toBe('0');
  expect(style.getPropertyValue('--pwa-dock-inbox-order')).toBe('1');
  expect(style.getPropertyValue('--pwa-dock-today-display')).toBe('none');
  expect(style.getPropertyValue('--pwa-opening-dock-indicator')).toBe('0');
  expect(document.documentElement.dataset.pwaOpeningTab).toBe('today');
});

it('selects a pinned Reading subview in the cached shell', () => {
	const { document } = parseHTML('<html><body></body></html>');
	new Script(PWA_OPENING_DOCK_INIT_JS).runInNewContext({
		document, URLSearchParams, location: { search: '' },
		localStorage: { getItem: () => JSON.stringify({ defaultScreen: 'favorites', dockTabs: ['highlights', 'archive', 'favorites', 'upcoming'] }) },
	});
	const style = document.documentElement.style;
	expect(style.getPropertyValue('--pwa-opening-dock-index')).toBe('2');
	expect(style.getPropertyValue('--pwa-dock-reading-display')).toBe('none');
	expect(style.getPropertyValue('--pwa-dock-favorites-active-order')).toBe('2');
});

it.each(['today', 'upcoming'])('migrates date-view slots and selects Reminders for %s in the cached shell', tab => {
	const { document } = parseHTML('<html><body></body></html>');
	new Script(PWA_OPENING_DOCK_INIT_JS).runInNewContext({
		document, URLSearchParams, location: { search: `?tab=${tab}` },
		localStorage: { getItem: () => JSON.stringify({ dockTabs: ['upcoming', 'today-view', 'inbox', 'reading'] }) },
	});
	expect(document.documentElement.dataset.pwaOpeningDockTab).toBe('today');
	expect(document.documentElement.style.getPropertyValue('--pwa-dock-today-active-order')).toBe('0');
});

it('marks only the last saved dock slot with the startup switch badge', () => {
	for (const dockTabs of [['reading', 'inbox', 'today', 'browse'], ['archive', 'favorites', 'highlights', 'today']]) {
		const { document } = parseHTML(`<html><body>${createPwaOpeningScreenHtml()}</body></html>`);
		new Script(PWA_OPENING_DOCK_INIT_JS).runInNewContext({
			document, URLSearchParams, location: { search: '' }, localStorage: { getItem: () => JSON.stringify({ dockTabs }) },
		});
		for (const [index, tab] of dockTabs.entries()) {
			expect(document.documentElement.style.getPropertyValue(`--pwa-dock-${tab}-hint`)).toBe(index === 3 ? 'flex' : 'none');
		}
	}
});
