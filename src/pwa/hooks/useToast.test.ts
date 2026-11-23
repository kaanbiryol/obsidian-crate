import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { getToastDuration, useToast } from './useToast';

describe('PWA toast duration', () => {
	it('keeps successful saves visible long enough to read', () => {
		expect(getToastDuration('success')).toBe(2800);
	});

	it('keeps longer durations for informational and error messages', () => {
		expect(getToastDuration('info')).toBe(3200);
		expect(getToastDuration('error')).toBe(4200);
	});

	it('leaves time to reach an inline action', () => {
		expect(getToastDuration('success', true)).toBe(6000);
	});
});

describe('PWA toast identity', () => {
	it('gives each message its own id, so a replacement fades in on its own', () => {
		const hook = renderHook(useToast);
		act(() => hook.current.showToast('success', 'Copied'));
		const first = hook.current.toast!.id;
		act(() => hook.current.showToast('success', 'Copied'));
		expect(hook.current.toast!.id).not.toBe(first);
		act(() => hook.current.clearToast());
		expect(hook.current.toast).toBeNull();
	});
});
