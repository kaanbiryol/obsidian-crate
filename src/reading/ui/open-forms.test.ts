import { act } from 'react';
import { expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { hasOpenReadingForm, useOpenReadingForm } from './open-forms';

it('reports an open Reading form only while one is mounted', () => {
	expect(hasOpenReadingForm()).toBe(false);
	const first = renderHook(() => useOpenReadingForm());
	const second = renderHook(() => useOpenReadingForm());
	expect(hasOpenReadingForm()).toBe(true);
	act(() => first.unmount());
	expect(hasOpenReadingForm()).toBe(true);
	act(() => second.unmount());
	expect(hasOpenReadingForm()).toBe(false);
});
