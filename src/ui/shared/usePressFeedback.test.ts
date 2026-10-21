import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { usePressFeedback } from './usePressFeedback';

type PressEvents = ReturnType<typeof usePressFeedback<HTMLElement>>['events'];
const pointer = (pointerType: string, x = 0, y = 0) => ({
	isPrimary: true, button: 0, pointerType, clientX: x, clientY: y,
	currentTarget: document.getElementById('root')!,
}) as unknown as Parameters<PressEvents['onPointerDown']>[0];
const fire = (handler: (event: never) => void, event: unknown) => { act(() => handler(event as never)); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('shows mouse presses at once but delays touch presses that may become scrolls', () => {
	const hook = renderHook(() => usePressFeedback<HTMLElement>());
	fire(hook.current.events.onPointerDown, pointer('mouse'));
	expect(hook.current.pressed).toBe(true);
	fire(hook.current.events.onPointerUp, pointer('mouse'));
	expect(hook.current.pressed).toBe(false);

	fire(hook.current.events.onPointerDown, pointer('touch'));
	expect(hook.current.pressed).toBe(false);
	fire(hook.current.events.onPointerMove, pointer('touch', 0, 20));
	act(() => { vi.advanceTimersByTime(200); });
	expect(hook.current.pressed).toBe(false);

	fire(hook.current.events.onPointerDown, pointer('touch'));
	act(() => { vi.advanceTimersByTime(100); });
	expect(hook.current.pressed).toBe(true);
	fire(hook.current.events.onPointerCancel, pointer('touch'));
	expect(hook.current.pressed).toBe(false);
});

it('flashes a quick tap after release, through its click', () => {
	const hook = renderHook(() => usePressFeedback<HTMLElement>());
	fire(hook.current.events.onPointerDown, pointer('touch'));
	fire(hook.current.events.onPointerUp, pointer('touch'));
	fire(hook.current.events.onClickCapture, {});
	expect(hook.current.pressed).toBe(true);
	act(() => { vi.advanceTimersByTime(150); });
	expect(hook.current.pressed).toBe(false);
});
