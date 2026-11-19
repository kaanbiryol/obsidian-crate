import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingSection } from '../core/reading-presentation';
import { useCollapseDepartedRows } from './useReadingListMotion';

it('settles rows that left while the list was not shown, since none is painted to collapse', () => {
	const lists = { current: new Map<ReadingSection, HTMLDivElement>() };
	const settle = vi.fn();
	let listed = false, hold = true;
	const hook = renderHook(() => useCollapseDepartedRows(lists, 'inbox', new Set(['queued']), settle, hold, listed));
	expect(settle).not.toHaveBeenCalled();
	hold = false;
	hook.rerender();
	expect(settle).toHaveBeenCalledWith(['queued']);
	listed = true;
	settle.mockClear();
	hook.rerender();
	expect(settle).not.toHaveBeenCalled();
});
