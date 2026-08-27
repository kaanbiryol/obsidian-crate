import { describe, expect, it } from 'vitest';
import { getPwaStatusText } from './usePwaStatus';

const now = new Date('2026-08-27T12:00:00.000Z').getTime();

describe('getPwaStatusText', () => {
	it('hides the transient cached status during initial refresh', () => {
		expect(getPwaStatusText({
			dataMode: 'cached',
			error: null,
			isOffline: false,
			lastUpdatedAt: now,
			now,
			refreshing: false,
		})).toBeNull();
	});

	it('shows cached status when the refresh failed', () => {
		expect(getPwaStatusText({
			dataMode: 'cached',
			error: 'Network error',
			isOffline: false,
			lastUpdatedAt: now,
			now,
			refreshing: false,
		})).toBe('Last updated just now - stale');
	});

	it('continues to show offline status for cached data', () => {
		expect(getPwaStatusText({
			dataMode: 'cached',
			error: null,
			isOffline: true,
			lastUpdatedAt: now,
			now,
			refreshing: false,
		})).toBe('Offline - Last updated just now');
	});
});
