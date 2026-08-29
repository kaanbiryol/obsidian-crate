import { describe, expect, it } from 'vitest';
import { preferredPwaColorScheme } from './usePwaColorScheme';

describe('preferredPwaColorScheme', () => {
	it('uses the light scheme when the system prefers light', () => {
		expect(preferredPwaColorScheme({ matches: true })).toBe('light');
	});

	it('uses the dark scheme otherwise', () => {
		expect(preferredPwaColorScheme({ matches: false })).toBe('dark');
	});
});
