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

/** Crossfades a tag change in place. Call the returned function as a tag is selected, after the
 * list scrolls to the top: once that tag's results show, a copy of the departing rows fades out
 * over the new list, so rows both tags list stay steady. */
export function useTagCrossfade(lists: SectionLists, section: ReadingSection, tag: string | null, loading: boolean): (next: string | null) => void {
	const reduceMotion = useReducedMotion();
	const shownFilter = useRef<{ section: ReadingSection; tag: string | null } | null>(null);
	const departingList = useRef<{ tag: string | null; node: HTMLElement } | null>(null);
	useLayoutEffect(() => {
		const previous = shownFilter.current, departing = departingList.current, list = lists.current.get(section);
		shownFilter.current = loading ? null : { section, tag };
		departingList.current = null;
		if (!previous || loading || previous.section !== section || departing?.tag !== tag || !list) return;
		const owner = list.ownerDocument.defaultView ?? window, style = owner.getComputedStyle(list);
		const duration = parseFloat(style.getPropertyValue('--pwa-motion-fade-duration'));
		if (!duration) return;
		const { node } = departing;
		Object.assign(node.style, {
			position: 'absolute', top: `${list.offsetTop}px`, left: `${list.offsetLeft}px`, width: `${list.offsetWidth}px`, height: `${list.offsetHeight}px`,
			boxSizing: 'border-box', pointerEvents: 'none', background: opaqueBackground(list, owner),
		});
		list.after(node);
		const animation = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: style.getPropertyValue('--pwa-motion-fade-ease').trim() || PWA_FADE_TIMING.easing });
		animation.onfinish = () => node.remove();
		return () => { animation.cancel(); node.remove(); };
	}, [lists, loading, section, tag]);
	return useCallback((next: string | null) => {
		// Copy the rows as they now show, scrolled to the top like the incoming list.
		const list = lists.current.get(section);
		departingList.current = list && !reduceMotion ? { tag: next, node: copyDepartingList(list) } : null;
	}, [lists, section, reduceMotion]);
}

/** A static, hidden copy of a list's rows for a crossfade; it takes no focus, input or ids. */
function copyDepartingList(list: HTMLElement): HTMLElement {
	const node = list.cloneNode(true) as HTMLElement;
	node.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
	node.removeAttribute('tabindex');
	node.inert = true;
	node.setAttribute('aria-hidden', 'true');
	node.dataset.departingList = 'true';
	return node;
}

/** The first painted background behind `element`, so a copy over the list hides it. */
function opaqueBackground(element: HTMLElement, owner: Window): string {
	for (let node: HTMLElement | null = element; node; node = node.parentElement) {
		const color = owner.getComputedStyle(node).backgroundColor;
		if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
	}
	return 'Canvas';
}
