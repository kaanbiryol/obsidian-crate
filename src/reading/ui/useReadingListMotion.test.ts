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
		vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name === '--pwa-motion-dismiss-duration' ? '200' : '', marginTop: '0px', marginBottom: '0px' }));
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

it('fades a departed row and slides the content after it up by transform, leaving layout to the settle', () => {
	const lists = { current: new Map<ReadingSection, HTMLDivElement>() };
	type Recorded = { node: HTMLElement; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null };
	const animations: Recorded[] = [];
	let row!: HTMLElement, below!: HTMLElement, nextGroup!: HTMLElement;
	let departed = new Set(['archived']);
	const settle = vi.fn();
	const hook = renderHook(() => useCollapseDepartedRows(lists, 'inbox', departed, settle, false, true), () => {
		vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => name === '--pwa-motion-dismiss-duration' ? '320' : '', marginTop: '0px', marginBottom: '6px' }));
		const list = document.createElement('div');
		const group = document.createElement('section'), rows = document.createElement('ul');
		row = document.createElement('li');
		row.dataset.departing = 'true';
		row.dataset.departed = 'archived';
		Object.defineProperty(row, 'offsetHeight', { value: 60 });
		below = document.createElement('li');
		nextGroup = document.createElement('section');
		rows.append(row, below);
		group.append(document.createElement('h3'), rows);
		list.append(group, nextGroup);
		document.body.append(list);
		for (const node of [row, below, nextGroup, group, rows]) Object.assign(node, { animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
			const animation = { node, keyframes, options, cancel: vi.fn(), onfinish: null };
			animations.push(animation);
			return animation;
		} });
		lists.current.set('inbox', list);
	});
	expect(animations.map(animation => animation.node)).toEqual([row, below, nextGroup]);
	const [fade, ...slides] = animations;
	expect(fade!.keyframes.every(keyframe => !('height' in keyframe))).toBe(true);
	expect(fade!.keyframes.at(-1)).toMatchObject({ opacity: 0 });
	for (const slide of slides) {
		expect(slide.keyframes.at(-1)).toEqual({ translate: '0 -66px' });
		expect(slide.options).toMatchObject({ duration: 320, composite: 'add', fill: 'forwards' });
	}
	fade!.onfinish?.();
	expect(settle).toHaveBeenCalledWith(['archived']);
	// The slide stays until the row leaves, then drops in the same commit as the row.
	expect(slides.every(slide => !slide.cancel.mock.calls.length)).toBe(true);
	row.remove();
	departed = new Set();
	hook.rerender();
	expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
});
