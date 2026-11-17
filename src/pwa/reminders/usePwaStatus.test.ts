import { describe, expect, it, vi } from 'vitest';
import { getPwaStatusText } from './usePwaStatus';
import { ENCRYPTION_UNVERIFIED } from '../encryption/encryption-verification';

const now = new Date('2026-08-27T12:00:00.000Z').getTime();

describe('getPwaStatusText', () => {
	it('hides the transient cached status during initial refresh', () => {
		expect(getPwaStatusText({
			dataMode: 'cached',
			error: null,
			isOffline: false,
			lastUpdatedAt: now,
			now,
		})).toBeNull();
	});

	it('shows cached status when the refresh failed', () => {
		expect(getPwaStatusText({
			dataMode: 'cached',
			error: 'Network error',
			isOffline: false,
			lastUpdatedAt: now,
			now,
		})).toBe('Couldn’t connect · updated just now');
	});

	it('continues to show offline status for cached data', () => {
		expect(getPwaStatusText({
			dataMode: 'cached',
			error: null,
			isOffline: true,
			lastUpdatedAt: now,
			now,
		})).toBe('Offline · updated just now');
	});

	it('keeps a server refusal reason but folds the unanswered check into one line', () => {
		const base = { dataMode: 'cached' as const, error: null, isOffline: false, lastUpdatedAt: now - 8 * 60_000, now };
		expect(getPwaStatusText({ ...base, unavailableMessage: ENCRYPTION_UNVERIFIED })).toBe('Couldn’t connect · updated 8m ago');
		expect(getPwaStatusText({ ...base, unavailableMessage: 'Too many requests. Try again shortly.' })).toBe('Too many requests. Try again shortly.');
		expect(getPwaStatusText({ ...base, dataMode: 'error', error: 'Load failed', lastUpdatedAt: null })).toBe('Couldn’t connect');
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
					lastUpdatedAt: now, push: { phase: 'on' } as never });
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
