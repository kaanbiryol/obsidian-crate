import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReadingSection } from '../core/reading-presentation';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { PWA_FADE_TIMING } from '@/ui/shared/navigation/motion';

type SectionLists = RefObject<Map<ReadingSection, HTMLDivElement>>;

/** Collapses rows that left `section`'s list, unless `hold` keeps them in place (as while the
 * reader that archived one closes), then `settle`s them so the rows below slide up. */
export function useCollapseDepartedRows(lists: SectionLists, section: ReadingSection, departed: ReadonlySet<string>,
	settle: (ids: readonly string[]) => void, hold: boolean): void {
	const collapsing = useRef(new Map<HTMLElement, Animation>());
	useLayoutEffect(() => {
		const list = lists.current.get(section);
		if (hold || !departed.size || !list) return;
		const owner = list.ownerDocument.defaultView ?? window, listStyle = owner.getComputedStyle(list);
		const duration = parseFloat(listStyle.getPropertyValue('--pwa-motion-dismiss-duration'));
		const easing = listStyle.getPropertyValue('--pwa-motion-surface-ease').trim() || 'ease-out';
		for (const node of list.querySelectorAll<HTMLElement>('[data-departing="true"]')) {
			if (collapsing.current.has(node)) continue;
			const ids = node.dataset.departed ? [node.dataset.departed] : [...node.querySelectorAll<HTMLElement>('[data-departed]')].map(row => row.dataset.departed!);
			if (!duration) { settle(ids); continue; }
			const style = owner.getComputedStyle(node);
			const animation = node.animate([
				{ height: `${node.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: style.marginBottom, opacity: 1 },
				{ height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px', opacity: 0 },
			], { duration, easing, fill: 'forwards' });
			collapsing.current.set(node, animation);
			animation.onfinish = () => { collapsing.current.delete(node); settle(ids); };
		}
	}, [lists, hold, departed, section, settle]);
	useEffect(() => () => { for (const animation of collapsing.current.values()) animation.cancel(); }, []);
}

/** Crossfades a tag change in place. Call the returned function as a tag is selected, after the
 * list scrolls to the top: once that tag's results show, a copy of the departing rows fades out
 * over the new list, so rows both tags list stay steady. */
export function useTagCrossfade(lists: SectionLists, section: ReadingSection, tag: string | null, loading: boolean, waiting: boolean): (next: string | null) => void {
	const reduceMotion = useReducedMotion();
	const shownFilter = useRef<{ section: ReadingSection; tag: string | null } | null>(null);
	const departingList = useRef<{ tag: string | null; node: HTMLElement } | null>(null);
	// Whether the last painted list was dimmed, read below before the next effect updates it.
	const wasWaiting = useRef(false);
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
		// Rows dimmed while the tag loaded leave from where they were.
		if (wasWaiting.current) node.dataset.pending = 'true';
		list.after(node);
		const animation = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: style.getPropertyValue('--pwa-motion-fade-ease').trim() || PWA_FADE_TIMING.easing });
		animation.onfinish = () => node.remove();
		return () => { animation.cancel(); node.remove(); };
	}, [lists, loading, section, tag]);
	useLayoutEffect(() => { wasWaiting.current = waiting; }, [waiting]);
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
