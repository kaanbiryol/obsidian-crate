import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { usePwaRefreshLifecycle } from './usePwaRefreshLifecycle';

it('refreshes immediately on reconnection, throttles page resumes, and removes listeners on unmount', async () => {
	const loadReminders = vi.fn(async () => {});
	const refreshPushState = vi.fn(async () => {});
	const options = { authToken: 'token', bootstrapped: true, hasHydratedCache: () => true, loadReminders, refreshPushState };
	const rendered = renderHook(() => usePwaRefreshLifecycle(options));
	expect(loadReminders).toHaveBeenCalledExactlyOnceWith({ silent: true });
	loadReminders.mockClear();
	await act(() => window.dispatchEvent(new window.Event('online')));
	expect(loadReminders).toHaveBeenCalledExactlyOnceWith({ silent: true, maxAgeMs: 0 });
	await act(() => window.dispatchEvent(new window.Event('pageshow')));
	expect(loadReminders).toHaveBeenLastCalledWith({ silent: true, maxAgeMs: 30_000 });
	rendered.unmount();
	loadReminders.mockClear();
	window.dispatchEvent(new window.Event('online'));
	expect(loadReminders).not.toHaveBeenCalled();
});
