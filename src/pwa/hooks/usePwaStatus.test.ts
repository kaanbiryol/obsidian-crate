import { describe, expect, it, vi } from 'vitest';
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

describe('usePwaStatus clock', () => {
	it('stops the status tick while the app is hidden and refreshes once when shown', async () => {
		const { renderHook } = await import('../../test/react-hooks');
		const { act } = await import('react');
		const { usePwaStatus } = await import('./usePwaStatus');
		vi.useFakeTimers();
		let renders = 0;
		let visibility: DocumentVisibilityState = 'hidden';
		try {
			renderHook(() => {
				renders++;
				return usePwaStatus({ authToken: 'token', bootstrapped: true, dataMode: 'live', error: null, isOffline: false,
					lastUpdatedAt: now, push: { phase: 'on' } as never, refreshing: false });
			}, () => {
				Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
				vi.stubGlobal('window', Object.assign(window, { setInterval, clearInterval }));
			});
			const mounted = renders;
			act(() => { vi.advanceTimersByTime(90_000); });
			// Before: three background re-renders of the whole runtime.
			expect(renders).toBe(mounted);
			visibility = 'visible';
			act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
			expect(renders).toBe(mounted + 1);
			act(() => { vi.advanceTimersByTime(30_000); });
			expect(renders).toBe(mounted + 2);
		} finally { vi.useRealTimers(); }
	});
});
