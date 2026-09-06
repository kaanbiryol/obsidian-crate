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
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', upcomingDays: null });
	});

	it('persists a custom range and each supported launch screen', () => {
		storage();
		for (const defaultScreen of ['today', 'inbox', 'upcoming', 'browse'] as const) {
			savePwaPreferences({ defaultScreen, upcomingDays: 23 });
			expect(loadPwaPreferences()).toEqual({ defaultScreen, upcomingDays: 23 });
		}
	});

	it.each([0, -1, 1.5, '14', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid stored ranges: %s', (upcomingDays) => {
		storage(JSON.stringify({ defaultScreen: 'invalid', upcomingDays }));
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', upcomingDays: null });
	});

	it.each(['{', 'null'])('recovers from malformed stored preferences: %s', (raw) => {
		storage(raw);
		expect(loadPwaPreferences()).toEqual({ defaultScreen: 'today', upcomingDays: null });
	});
});
