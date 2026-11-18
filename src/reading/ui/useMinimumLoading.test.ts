import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useMinimumLoading } from './useMinimumLoading';

it('keeps a visible spinner for its minimum, and ends a loading state whose spinner never appeared', async () => {
	vi.useFakeTimers();
	try {
		let loading = true, delay = 250;
		const hook = renderHook(() => useMinimumLoading(loading, delay, 300));
		// Answered before the spinner appeared: nothing flickered, so no hold.
		await act(async () => { await vi.advanceTimersByTimeAsync(200); });
		loading = false;
		hook.rerender();
		expect(hook.current.loading).toBe(false);
		// Answered 50ms after the spinner appeared: it stays its full 300ms.
		loading = true;
		hook.rerender();
		await act(async () => { await vi.advanceTimersByTimeAsync(300); });
		loading = false;
		hook.rerender();
		expect(hook.current).toMatchObject({ loading: true, appearDelayMs: 250 });
		await act(async () => { await vi.advanceTimersByTimeAsync(249); });
		expect(hook.current.loading).toBe(true);
		await act(async () => { await vi.advanceTimersByTimeAsync(1); });
		expect(hook.current.loading).toBe(false);
		// An immediate spinner keeps its delay until it ends, even when the asked delay changes.
		loading = true; delay = 0;
		hook.rerender();
		await act(async () => { await vi.advanceTimersByTimeAsync(10); });
		loading = false; delay = 250;
		hook.rerender();
		expect(hook.current).toMatchObject({ loading: true, appearDelayMs: 0 });
		await act(async () => { await vi.advanceTimersByTimeAsync(290); });
		expect(hook.current).toMatchObject({ loading: false, appearDelayMs: 250 });
	} finally { vi.useRealTimers(); }
});
