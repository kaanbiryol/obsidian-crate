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

it('shows a collapsing date group again when a new row joins it, as a saved link replaces its pending copy', () => {
	const lists = { current: new Map<ReadingSection, HTMLDivElement>() };
	const animations: Array<{ cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }> = [];
	let group!: HTMLElement;
	let departed = new Set(['pending']);
	const settle = vi.fn();
	const hook = renderHook(() => useCollapseDepartedRows(lists, 'inbox', departed, settle, false, true), () => {
		vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name === '--pwa-motion-dismiss-duration' ? '200' : '', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px' }));
		const list = document.createElement('div');
		group = document.createElement('section');
		group.dataset.departing = 'true';
		const row = document.createElement('li');
		row.dataset.departed = 'pending';
		group.append(row);
		list.append(group);
		document.body.append(list);
		Object.assign(group, { animate: () => { const animation = { cancel: vi.fn(), onfinish: null }; animations.push(animation); return animation; } });
		lists.current.set('inbox', list);
	});
	expect(animations).toHaveLength(1);
	// The saved copy joins the group while it collapses; its pending row still leaves on its own.
	delete group.dataset.departing;
	departed = new Set(['pending']);
	hook.rerender();
	expect(animations[0]!.cancel).toHaveBeenCalled();
	// A collapse that already finished is also undone once the group gains a row.
	group.dataset.departing = 'true';
	departed = new Set(['pending']);
	hook.rerender();
	expect(animations).toHaveLength(2);
	animations[1]!.onfinish?.();
	expect(settle).toHaveBeenCalledWith(['pending']);
	delete group.dataset.departing;
	departed = new Set();
	hook.rerender();
	expect(animations[1]!.cancel).toHaveBeenCalled();
});
