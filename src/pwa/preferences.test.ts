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
	it('defaults to Today and inherits the configured upcoming range', () => {
		storage();
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', upcomingDays: null, dockTabs: [...DEFAULT_DOCK_TABS], reminderListStyle: 'flat' });
	});

	it('persists a custom range and each supported launch screen', () => {
		storage();
		for (const defaultScreen of ['today', 'inbox', 'upcoming', 'browse', 'reading', 'favorites', 'archive'] as const) {
			savePwaPreferences({ defaultScreen, upcomingDays: 23, dockTabs: [...DEFAULT_DOCK_TABS], reminderListStyle: 'flat' });
			expect(loadPwaPreferences()).toEqual({ defaultScreen, upcomingDays: 23, dockTabs: [...DEFAULT_DOCK_TABS], reminderListStyle: 'flat' });
		}
	});

	it.each([0, -1, 1.5, '14', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid stored ranges: %s', (upcomingDays) => {
		storage(JSON.stringify({ defaultScreen: 'invalid', upcomingDays }));
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', upcomingDays: null, dockTabs: [...DEFAULT_DOCK_TABS], reminderListStyle: 'flat' });
	});

	it.each(['{', 'null'])('recovers from malformed stored preferences: %s', (raw) => {
		storage(raw);
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', upcomingDays: null, dockTabs: [...DEFAULT_DOCK_TABS], reminderListStyle: 'flat' });
	});
});

it.each([
  [undefined, [...DEFAULT_DOCK_TABS]],
  [[], [...DEFAULT_DOCK_TABS]],
  [['unknown'], [...DEFAULT_DOCK_TABS]],
  [['reading', 'today', 'reading', null, 'bad'], ['reading', 'today', 'inbox', 'browse']],
  [['browse'], ['browse', 'inbox', 'today', 'reading']],
  [['highlights', 'favorites', 'archive', 'upcoming', 'inbox'], ['highlights', 'favorites', 'archive', 'today']],
])('normalizes dock preferences without losing their order: %j', (dockTabs, expected) => {
  storage(JSON.stringify({ dockTabs }));
  expect(loadPwaPreferences().dockTabs).toEqual(expected);
});

it('persists hidden and reordered tabs independently of the launch screen', () => {
  storage();
  savePwaPreferences({ ...loadPwaPreferences(), dockTabs: ['reading', 'inbox'] });
  expect(loadPwaPreferences()).toMatchObject({ defaultScreen: 'today', dockTabs: ['reading', 'inbox', 'today', 'browse'] });
});

it.each(['flat', 'cards'] as const)('persists the %s reminder style without changing other preferences', reminderListStyle => {
  storage();
  savePwaPreferences({ ...loadPwaPreferences(), reminderListStyle });
  expect(loadPwaPreferences()).toMatchObject({ reminderListStyle, defaultScreen: 'today', upcomingDays: null });
});

it.each([undefined, null, 'compact', 42])('defaults invalid reminder styles to flat: %s', reminderListStyle => {
  storage(JSON.stringify({ reminderListStyle }));
  expect(loadPwaPreferences().reminderListStyle).toBe('flat');
});
