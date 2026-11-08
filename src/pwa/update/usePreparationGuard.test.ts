import { act } from 'react';
import { expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { usePreparationGuard } from './usePreparationGuard';

it('reports overlapping preparations synchronously and when rendered, including failures', async () => {
	const rendered = renderHook(() => usePreparationGuard());
	let finishFirst!: () => void, failSecond!: (error: Error) => void;
	let first!: Promise<string>, second!: Promise<never>;
	act(() => {
		first = rendered.current.track(() => new Promise<string>(resolve => { finishFirst = () => resolve('saved'); }));
		// Before the next render, an update check already sees the preparation.
		expect(rendered.current.isPreparing()).toBe(true);
		second = rendered.current.track(() => new Promise<never>((_, reject) => { failSecond = reject; }));
	});
	expect(rendered.current.preparing).toBe(true);
	await act(async () => { failSecond(new Error('Storage unavailable')); await expect(second).rejects.toThrow('Storage unavailable'); });
	expect(rendered.current.isPreparing()).toBe(true);
	expect(rendered.current.preparing).toBe(true);
	await act(async () => { finishFirst(); await expect(first).resolves.toBe('saved'); });
	expect(rendered.current.isPreparing()).toBe(false);
	expect(rendered.current.preparing).toBe(false);
});
