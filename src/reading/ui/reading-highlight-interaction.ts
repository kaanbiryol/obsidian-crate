import type { RefObject } from 'react';
import type { ReadingHighlight } from '../core/highlights';
import { highlightOffsetAtPoint, highlightTextRects, resizeHighlight, selectedHighlight } from './reader-highlights';
import { readerScrollElement } from './reader-scroll';

export type HighlightEdit = { original: ReadingHighlight | null; highlight: ReadingHighlight };

/** One owner for native selection, portable handles, keyboard editing and their cleanup. */
export function registerReadingHighlightInteraction(options: {
	reader: HTMLElement; text: HTMLDivElement; controls: RefObject<HTMLDivElement | null>;
	getState: () => { editing: HighlightEdit | null; saving: boolean; disabled: boolean; highlights: ReadingHighlight[] };
	edit: (value: HighlightEdit | null) => void;
	select: (value: HighlightEdit) => void;
	onSelect: (highlight: ReadingHighlight) => void;
	persist: (value: HighlightEdit) => void;
	onDismiss: () => void;
	relayout: () => void;
}) {
	const { reader, text, controls, edit, onSelect, persist, relayout } = options;
	const document = reader.ownerDocument, window = document.defaultView!;
	let held = false, nativeIntent = false, timer = 0, frame = 0, suppressClickUntil = 0;
	let drag: { edge: 'start' | 'end'; pointer: number; initial: HighlightEdit; x: number; y: number; deltaY: number; target: HTMLElement } | null = null;
	const eventTarget = (event: Event) => (event.composedPath()[0] ?? event.target) as HTMLElement;
	const activeElement = () => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return active;
	};
	const dismiss = () => { options.onDismiss(); nativeIntent = false; window.clearTimeout(timer); };
	const finishNativeSelection = () => {
		const { saving } = options.getState();
		if (held || drag || !nativeIntent || saving || controls.current?.contains(activeElement())) return;
		const highlight = selectedHighlight(text);
		if (!highlight) return;
		onSelect(highlight);
		nativeIntent = false; suppressClickUntil = Date.now() + 400;
		const original = options.getState().highlights.find(entry => entry.start === highlight.start && entry.end === highlight.end) ?? null;
		const value = { original, highlight }; options.select(value);
		document.getSelection()?.removeAllRanges();
		if (!original) persist(value);
	};
	const settle = () => { window.clearTimeout(timer); timer = window.setTimeout(finishNativeSelection, 120); };
	const selectionChanged = () => {
		if (controls.current?.contains(activeElement())) return;
		if (selectedHighlight(text)) nativeIntent = true;
		if (nativeIntent && !held) settle();
	};
	const activate = (event: MouseEvent | KeyboardEvent) => {
		if ('key' in event && !['Enter', ' '].includes(event.key)) return;
		const mark = eventTarget(event).closest<HTMLElement>('.crate-reading-reader__highlight');
		if (!mark || !text.contains(mark)) return;
		if ((!('key' in event) && Date.now() < suppressClickUntil) || selectedHighlight(text)) return;
		event.preventDefault(); nativeIntent = false;
		const start = Number(mark.dataset.highlightStart), end = Number(mark.dataset.highlightEnd);
		const highlight = { start, end, text: (text.textContent ?? '').slice(start, end) };
		onSelect(highlight);
		options.select({ original: highlight, highlight });
	};
	const updateDrag = () => {
		const { editing } = options.getState();
		if (!drag || !editing) return;
		const bounds = text.getBoundingClientRect(), viewport = reader.getBoundingClientRect();
		const navBottom = Math.max(0, reader.querySelector('nav')?.getBoundingClientRect().bottom ?? viewport.top);
		const y = Math.max(navBottom + 2, Math.min(Math.min(viewport.bottom, window.innerHeight) - 2, drag.y + drag.deltaY));
		// Caret hit-testing must see the article under the moving handle's touch target.
		const overlay = controls.current;
		overlay?.classList.add('is-hit-testing');
		let offset: number | null;
		try { offset = highlightOffsetAtPoint(text, Math.max(bounds.left + 1, Math.min(bounds.right - 1, drag.x)), y); }
		finally { overlay?.classList.remove('is-hit-testing'); }
		if (offset !== null) edit({ ...editing, highlight: resizeHighlight(text.textContent ?? '', editing.highlight, drag.edge, offset) });
	};
	const autoScroll = () => {
		if (!drag) return;
		const bounds = reader.getBoundingClientRect(), top = Math.max(0, reader.querySelector('nav')?.getBoundingClientRect().bottom ?? bounds.top);
		const bottom = Math.min(bounds.bottom, window.innerHeight);
		const delta = drag.y < top + 40 ? -8 : drag.y > bottom - 40 ? 8 : 0;
		if (delta) { readerScrollElement(reader).scrollTop += delta; updateDrag(); }
		frame = window.requestAnimationFrame(autoScroll);
	};
	const down = (event: PointerEvent) => {
		if (event.button !== 0) return;
		const { editing, saving, disabled } = options.getState();
		const target = eventTarget(event);
		const handle = target.closest<HTMLElement>('[data-highlight-edge]');
		if (handle && controls.current?.contains(handle) && editing && !saving && !disabled) {
			event.preventDefault(); nativeIntent = false; held = false;
			const edge = handle.dataset.highlightEdge as 'start' | 'end';
			const rect = highlightTextRects(text, editing.highlight);
			const endRect = edge === 'start' ? rect?.[0] : rect?.[rect.length - 1];
			drag = { edge, pointer: event.pointerId, initial: editing, x: event.clientX, y: event.clientY, deltaY: endRect ? (endRect.top + endRect.bottom) / 2 - event.clientY : 0, target: handle };
			handle.setPointerCapture(event.pointerId); frame = window.requestAnimationFrame(autoScroll); return;
		}
		if (controls.current?.contains(target)) return;
		dismiss(); suppressClickUntil = 0; held = true; nativeIntent = text.contains(target);
	};
	const move = (event: PointerEvent) => {
		if (!drag || drag.pointer !== event.pointerId) return;
		event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY; updateDrag();
	};
	const endDrag = (cancel: boolean) => {
		if (!drag) return;
		const previous = drag; drag = null; window.cancelAnimationFrame(frame);
		if (previous.target.hasPointerCapture(previous.pointer)) previous.target.releasePointerCapture(previous.pointer);
		const { editing } = options.getState();
		if (cancel) edit(previous.initial);
		else if (editing) { onSelect(editing.highlight); persist(editing); }
		suppressClickUntil = Date.now() + 400;
	};
	const up = (event: PointerEvent) => {
		if (drag?.pointer === event.pointerId) { endDrag(false); return; }
		held = false; settle();
	};
	const cancel = (event: PointerEvent) => {
		if (drag?.pointer === event.pointerId) endDrag(true);
		// Native mobile selection can cancel Pointer Events; touchend still owns release.
		if (event.pointerType !== 'touch') { held = false; nativeIntent = false; }
	};
	const touchEnd = () => { held = false; if (!drag) settle(); };
	const touchCancel = () => { held = false; nativeIntent = false; endDrag(true); };
	const keydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape') { endDrag(true); dismiss(); return; }
		const { editing, disabled, saving } = options.getState();
		const edge = eventTarget(event).dataset.highlightEdge as 'start' | 'end' | undefined;
		if (edge && editing && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !disabled && !saving) {
			event.preventDefault();
			edit({ ...editing, highlight: resizeHighlight(text.textContent ?? '', editing.highlight, edge, editing.highlight[edge] + (event.key === 'ArrowLeft' ? -1 : 1)) });
		} else if (event.shiftKey && event.key.startsWith('Arrow') && !controls.current?.contains(eventTarget(event))) nativeIntent = true;
	};
	const keyup = (event: KeyboardEvent) => {
		const { editing } = options.getState();
		if (eventTarget(event).dataset.highlightEdge && event.key.startsWith('Arrow') && editing) persist(editing);
		else settle();
	};
	// Status and content updates can move the passage without a scroll event.
	const resize = new ResizeObserver(relayout);
	resize.observe(reader); resize.observe(text);
	const page = reader.querySelector('.crate-reading-reader__page');
	if (page) resize.observe(page);
	const scroll = (event: Event) => {
		if (event.target !== document && event.target !== document.scrollingElement && !reader.contains(eventTarget(event))) return;
		if (drag) relayout();
		else if (options.getState().editing) dismiss();
	};
	const blur = () => { held = false; nativeIntent = false; endDrag(true); };
	document.addEventListener('selectionchange', selectionChanged);
	document.addEventListener('pointerdown', down); document.addEventListener('pointermove', move, { passive: false });
	document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
	document.addEventListener('touchend', touchEnd, { passive: true }); document.addEventListener('touchcancel', touchCancel, { passive: true });
	document.addEventListener('keydown', keydown); document.addEventListener('keyup', keyup);
	text.addEventListener('click', activate); text.addEventListener('keydown', activate);
	document.addEventListener('scroll', scroll, true); window.addEventListener('resize', relayout); window.addEventListener('blur', blur);
	return { dismiss, dispose() {
		resize.disconnect(); window.clearTimeout(timer); window.cancelAnimationFrame(frame);
		document.removeEventListener('selectionchange', selectionChanged);
		document.removeEventListener('pointerdown', down); document.removeEventListener('pointermove', move);
		document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
		document.removeEventListener('touchend', touchEnd); document.removeEventListener('touchcancel', touchCancel);
		document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup);
		text.removeEventListener('click', activate); text.removeEventListener('keydown', activate);
		document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', relayout); window.removeEventListener('blur', blur);
	} };
}
