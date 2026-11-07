import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useOnlineStatus } from './useOnlineStatus';

it('follows online and offline events and reports each one', () => {
	const onChange = vi.fn();
	const rendered = renderHook(() => useOnlineStatus(onChange), () => vi.stubGlobal('navigator', { onLine: false }));
	expect(rendered.current).toBe(false);
	act(() => { window.dispatchEvent(new window.Event('online')); });
	expect(rendered.current).toBe(true);
	act(() => { window.dispatchEvent(new window.Event('offline')); window.dispatchEvent(new window.Event('offline')); });
	expect(rendered.current).toBe(false);
	expect(onChange).toHaveBeenCalledTimes(3);
	rendered.unmount();
	window.dispatchEvent(new window.Event('online'));
	expect(onChange).toHaveBeenCalledTimes(3);
});
