import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useSheetTransition } from './useSheetTransition';

afterEach(() => { vi.useRealTimers(); });

it('keeps the close fallback timer through renders with a new callback', () => {
	vi.useFakeTimers();
	const calls: string[] = [];
	let label = 'first';
	const hook = renderHook(() => useSheetTransition(() => calls.push(label)));
	act(() => hook.current.requestClose());
	vi.advanceTimersByTime(600);
	label = 'latest';
	hook.rerender();
	act(() => { vi.advanceTimersByTime(400); });
	expect(calls).toEqual(['latest']);
	expect(hook.current.isClosing).toBe(false);
});

it('closes once when the exit animation finishes before the fallback', () => {
	vi.useFakeTimers();
	const onClosed = vi.fn();
	const hook = renderHook(() => useSheetTransition(onClosed));
	act(() => hook.current.requestClose());
	act(() => hook.current.finishClose());
	act(() => { vi.advanceTimersByTime(1000); });
	expect(onClosed).toHaveBeenCalledTimes(1);
});
