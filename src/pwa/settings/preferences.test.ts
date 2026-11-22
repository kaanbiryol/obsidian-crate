import { DEFAULT_DOCK_TABS } from './dock-preferences';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPwaPreferences, savePwaPreferences } from './preferences';

afterEach(() => vi.unstubAllGlobals());

function storage(raw: string | null = null) {
	let stored = raw;
	vi.stubGlobal('localStorage', {
		getItem: () => stored,
		setItem: (_key: string, value: string) => { stored = value; },
	});
}

describe('PWA preferences', () => {
	it('defaults to Today', () => {
		storage();
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', dockTabs: [...DEFAULT_DOCK_TABS], listStyle: 'flat' });
	});

	it('persists each supported launch screen', () => {
		storage();
		for (const defaultScreen of ['today', 'inbox', 'upcoming', 'browse', 'reading', 'favorites', 'archive'] as const) {
			savePwaPreferences({ defaultScreen, dockTabs: [...DEFAULT_DOCK_TABS], listStyle: 'flat' });
			expect(loadPwaPreferences()).toEqual({ defaultScreen, dockTabs: [...DEFAULT_DOCK_TABS], listStyle: 'flat' });
		}
	});

	it('rejects an invalid launch screen', () => {
		storage(JSON.stringify({ defaultScreen: 'invalid' }));
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', dockTabs: [...DEFAULT_DOCK_TABS], listStyle: 'flat' });
	});

	it.each(['{', 'null'])('recovers from malformed stored preferences: %s', (raw) => {
		storage(raw);
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', dockTabs: [...DEFAULT_DOCK_TABS], listStyle: 'flat' });
	});
});

it.each([
	[undefined, [...DEFAULT_DOCK_TABS]],
	[[], [...DEFAULT_DOCK_TABS]],
	[['unknown'], [...DEFAULT_DOCK_TABS]],
	[['reading', 'today', 'reading', null, 'bad'], ['reading', 'today', 'inbox', 'browse']],
	[['browse'], ['browse', 'inbox', 'today', 'reading']],
	[['highlights', 'favorites', 'archive', 'upcoming', 'inbox'], ['highlights', 'favorites', 'archive', 'inbox']],
])('normalizes dock preferences without losing their order: %j', (dockTabs, expected) => {
	storage(JSON.stringify({ dockTabs }));
	expect(loadPwaPreferences().dockTabs).toEqual(expected);
});

it('persists hidden and reordered tabs independently of the launch screen', () => {
	storage();
	savePwaPreferences({ ...loadPwaPreferences(), dockTabs: ['reading', 'inbox'] });
	expect(loadPwaPreferences()).toMatchObject({ defaultScreen: 'today', dockTabs: ['reading', 'inbox', 'today', 'browse'] });
});

it.each(['flat', 'cards'] as const)('persists the %s reminder style without changing other preferences', listStyle => {
	storage();
	savePwaPreferences({ ...loadPwaPreferences(), listStyle });
	expect(loadPwaPreferences()).toMatchObject({ listStyle, defaultScreen: 'today' });
});

it.each([undefined, null, 'compact', 42])('defaults invalid reminder styles to flat: %s', listStyle => {
	storage(JSON.stringify({ listStyle }));
	expect(loadPwaPreferences().listStyle).toBe('flat');
});
