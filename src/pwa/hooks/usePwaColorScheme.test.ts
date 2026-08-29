import { describe, expect, it } from 'vitest';
import {
	lightThemeMediaForPreference,
	loadPwaThemePreference,
	parsePwaThemePreference,
	PWA_THEME_PREFERENCE_KEY,
	preferredPwaColorScheme,
	resolvePwaColorScheme,
	savePwaThemePreference,
} from '../theme';

describe('preferredPwaColorScheme', () => {
	it('uses the light scheme when the system prefers light', () => {
		expect(preferredPwaColorScheme({ matches: true })).toBe('light');
	});

	it('uses the dark scheme otherwise', () => {
		expect(preferredPwaColorScheme({ matches: false })).toBe('dark');
	});
});

describe('PWA theme preferences', () => {
	it('uses an explicit theme instead of the system scheme', () => {
		expect(resolvePwaColorScheme('light', 'dark')).toBe('light');
		expect(resolvePwaColorScheme('dark', 'light')).toBe('dark');
		expect(resolvePwaColorScheme('system', 'light')).toBe('light');
	});

	it('falls back to system for missing or invalid stored values', () => {
		expect(parsePwaThemePreference('sepia')).toBe('system');
		expect(loadPwaThemePreference({ getItem: () => null })).toBe('system');
		expect(loadPwaThemePreference({ getItem: () => 'light' })).toBe('light');
	});

	it('persists the selected theme for the device', () => {
		let storedEntry: [string, string] | null = null;
		savePwaThemePreference('dark', {
			setItem: (key, value) => {
				storedEntry = [key, value];
			},
		});

		expect(storedEntry).toEqual([PWA_THEME_PREFERENCE_KEY, 'dark']);
	});

	it('switches the light stylesheet media for each preference', () => {
		expect(lightThemeMediaForPreference('system')).toBe('(prefers-color-scheme: light)');
		expect(lightThemeMediaForPreference('light')).toBe('all');
		expect(lightThemeMediaForPreference('dark')).toBe('not all');
	});
});
