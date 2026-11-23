import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReadingSection } from '../core/reading-presentation';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { PWA_FADE_TIMING } from '@/ui/shared/navigation/motion';

type SectionLists = RefObject<Map<ReadingSection, HTMLDivElement>>;

/** Collapses rows that left `section`'s list, unless `hold` keeps them in place (as while the
 * reader that archived one closes), then `settle`s them so the rows below slide up. Rows that
 * left while the list was not `listed`, as behind a loading state, settle at once.
 * A departing row fades in place while the content after it slides up over its space with a
 * transform; layout changes once, when `settle` removes the row and the slide is dropped. */
export function useCollapseDepartedRows(lists: SectionLists, section: ReadingSection, departed: ReadonlySet<string>,
	settle: (ids: readonly string[]) => void, hold: boolean, listed: boolean): void {
	const collapsing = useRef(new Map<HTMLElement, Animation[]>());
	useLayoutEffect(() => {
		// A collapse holds its node faded, and the content below slid up, until the node leaves;
		// dropping the slide in the same commit keeps that content still. A node that stays, as a
		// date group that gains a new row (a saved link replacing its pending copy), shows again.
		for (const [node, animations] of collapsing.current) {
			if (node.isConnected && node.dataset.departing === 'true') continue;
			for (const animation of animations) animation.cancel();
			collapsing.current.delete(node);
		}
		if (hold || !departed.size) return;
		// No row is painted to collapse, and the effect would not run again once one is.
		if (!listed) { settle([...departed]); return; }
		const list = lists.current.get(section);
		if (!list) return;
		const owner = list.ownerDocument.defaultView ?? window, listStyle = owner.getComputedStyle(list);
		const duration = parseFloat(listStyle.getPropertyValue('--pwa-motion-dismiss-duration'));
		const easing = listStyle.getPropertyValue('--pwa-motion-surface-ease').trim() || 'ease-out';
		for (const node of list.querySelectorAll<HTMLElement>('[data-departing="true"]')) {
			if (collapsing.current.has(node)) continue;
			const ids = node.dataset.departed ? [node.dataset.departed] : [...node.querySelectorAll<HTMLElement>('[data-departed]')].map(row => row.dataset.departed!);
			if (!duration) { settle(ids); continue; }
			const style = owner.getComputedStyle(node);
			const space = node.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
			const timing: KeyframeAnimationOptions = { duration, easing, fill: 'forwards' };
			const fade = node.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '0.96' }], timing);
			// Rows that depart together each add their own slide to the content below them.
			const slides = contentAfter(node, list).map(follower => follower.animate(
				[{ translate: '0 0' }, { translate: `0 ${-space}px` }], { ...timing, composite: 'add' }));
			collapsing.current.set(node, [fade, ...slides]);
			fade.onfinish = () => settle(ids);
		}
	}, [lists, hold, listed, departed, section, settle]);
	useEffect(() => () => {
		for (const animations of collapsing.current.values()) for (const animation of animations) animation.cancel();
	}, []);
}

/** The elements after `node` inside `list`, at each level up to the list: the content that
 * moves up once `node` leaves. */
function contentAfter(node: HTMLElement, list: HTMLElement): HTMLElement[] {
	const after: HTMLElement[] = [];
	for (let level: Element = node; level !== list && level.parentElement; level = level.parentElement) {
		for (let next = level.nextElementSibling; next; next = next.nextElementSibling) after.push(next as HTMLElement);
	}
	return after;
}

/** Animates a tag change row by row. Call the returned function as a tag is selected, after the
 * list scrolls to the top: once that tag's results show, rows only the old tag listed fade out
 * where they were, then rows and date headers both tags list slide to their new place while
 * rows new to the screen fade in. Only what is on screen moves, so the cost stays
 * small however long the list is. */
// The share of a tag switch's fade spent on the old rows leaving, and their curve.
const FADE_THROUGH_OUT = 0.35;
const FADE_THROUGH_OUT_EASE = 'cubic-bezier(0.4, 0, 1, 1)';

interface ShownRow { top: number; left: number; width: number; copy: HTMLElement }

export function useTagCrossfade(lists: SectionLists, section: ReadingSection, tag: string | null, loading: boolean): (next: string | null) => void {
	const reduceMotion = useReducedMotion();
	const shownFilter = useRef<{ section: ReadingSection; tag: string | null } | null>(null);
	const departingRows = useRef<{ tag: string | null; rows: Map<string, ShownRow> } | null>(null);
	useLayoutEffect(() => {
		const previous = shownFilter.current, departing = departingRows.current, list = lists.current.get(section);
		shownFilter.current = loading ? null : { section, tag };
		departingRows.current = null;
		if (!previous || loading || previous.section !== section || departing?.tag !== tag || !list) return;
		const owner = list.ownerDocument.defaultView ?? window, style = owner.getComputedStyle(list);
		const duration = parseFloat(style.getPropertyValue('--pwa-motion-fade-duration'));
		if (!duration) return;
		const ease = style.getPropertyValue('--pwa-motion-fade-ease').trim() || PWA_FADE_TIMING.easing;
		const leave = duration * FADE_THROUGH_OUT;
		const old = new Map(departing.rows), animations: Animation[] = [];
		for (const [key, element, bounds] of shownRows(list, owner)) {
			const before = old.get(key);
			old.delete(key);
			if (!before) {
				// Arrive once the rows leaving this spot have gone, so no two rows of text overlap.
				animations.push(element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration - leave, delay: leave, easing: ease, fill: 'backwards' }));
			} else if (Math.abs(before.top - bounds.top) > 0.5) {
				// Close the gaps once the rows leaving have gone, rather than sliding over them.
				animations.push(element.animate([{ translate: `0 ${before.top - bounds.top}px` }, { translate: '0 0' }], { duration, delay: leave, easing: ease, fill: 'backwards' }));
			}
		}
		if (!old.size && !animations.length) return;
		// Rows only the old tag listed fade out where they were drawn, over the new list.
		const node = list.ownerDocument.createElement('div');
		// Row and date header styles apply inside a group's list.
		node.className = 'crate-reading__group crate-reading__list';
		node.inert = true;
		node.setAttribute('aria-hidden', 'true');
		node.dataset.departingList = 'true';
		Object.assign(node.style, { position: 'absolute', top: `${list.offsetTop}px`, left: `${list.offsetLeft}px`, width: `${list.offsetWidth}px`, height: '0', pointerEvents: 'none' });
		list.after(node);
		// Offsets round to whole pixels; place the copies from where the overlay actually landed.
		const origin = list.getBoundingClientRect(), landed = node.getBoundingClientRect();
		for (const { top, left, width, copy } of old.values()) {
			Object.assign(copy.style, { position: 'absolute', top: `${top + origin.top - landed.top}px`, left: `${left + origin.left - landed.left}px`, width: `${width}px`, margin: '0', boxSizing: 'border-box' });
			node.append(copy);
		}
		const leaving = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: leave, easing: FADE_THROUGH_OUT_EASE, fill: 'forwards' });
		leaving.onfinish = () => node.remove();
		return () => { leaving.cancel(); for (const animation of animations) animation.cancel(); node.remove(); };
	}, [lists, loading, section, tag]);
	return useCallback((next: string | null) => {
		// Measure and copy the rows as they now show, scrolled to the top like the incoming list.
		const list = lists.current.get(section);
		if (!list || reduceMotion) { departingRows.current = null; return; }
		const owner = list.ownerDocument.defaultView ?? window;
		const rows = new Map<string, ShownRow>();
		for (const [key, element, bounds] of shownRows(list, owner)) rows.set(key, { ...bounds, copy: copyRow(element) });
		departingRows.current = { tag: next, rows };
	}, [lists, section, reduceMotion]);
}

/** The date headers and rows of `list` on screen, keyed so both tags' lists match up, with
 * their place relative to the list. */
function shownRows(list: HTMLElement, owner: Window): [string, HTMLElement, { top: number; left: number; width: number }][] {
	const origin = list.getBoundingClientRect(), bottom = Math.min(origin.bottom, owner.innerHeight);
	const rows: [string, HTMLElement, { top: number; left: number; width: number }][] = [];
	for (const element of list.querySelectorAll<HTMLElement>('.crate-reading__group > h3, .crate-reading__item')) {
		const bounds = element.getBoundingClientRect();
		if (bounds.bottom <= Math.max(origin.top, 0) || bounds.top >= bottom) continue;
		const id = element.querySelector<HTMLElement>('[data-reading-id]')?.dataset.readingId;
		const key = id ? `row:${id}` : `group:${element.textContent ?? ''}`;
		rows.push([key, element, { top: bounds.top - origin.top, left: bounds.left - origin.left, width: bounds.width }]);
	}
	return rows;
}

/** A static copy of a row for its exit; it takes no focus, input or ids. */
function copyRow(row: HTMLElement): HTMLElement {
	const node = row.cloneNode(true) as HTMLElement;
	node.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
	node.removeAttribute('id');
	return node;
}
