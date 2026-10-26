import { expect, it } from 'vitest';
import { MAX_TIMER_SECONDS, normalizeSharedSettingsValue } from './shared-settings';

it('rejects shared settings missing required flags', () => {
	expect(normalizeSharedSettingsValue({
		ignorePatterns: ['.git/'],
		syncInterval: 30,
	})).toBeNull();
});

it('clamps an interval longer than browser timers can wait', () => {
	expect(normalizeSharedSettingsValue({ ignorePatterns: [], syncInterval: 3_000_000, pushEnabled: false }))
		.toEqual({ ignorePatterns: [], syncInterval: MAX_TIMER_SECONDS, pushEnabled: false });
	// A delay above 2^31-1 ms would fire at once and turn periodic sync into a loop.
	expect(MAX_TIMER_SECONDS * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
});
