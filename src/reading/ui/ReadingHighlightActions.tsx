import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { readingHighlights, type ReadingHighlight } from '../core/highlights';
import { highlightOffsetAtPoint, highlightRange, highlightTextRects, resizeHighlight, selectedHighlight } from './reader-highlights';

type Editing = { original: ReadingHighlight | null; highlight: ReadingHighlight };
type Box = { left: number; top: number; width: number; height: number };
type Geometry = { boxes: Box[]; start: Box; end: Box; menu: { left: number; top: number }; feedback: { left: number; top: number } };

/** Native initial selection; portable handles for editing a saved annotation. */
export function ReadingHighlightActions({ body, article, content, highlights, onSave, disabled }: {
	body: React.RefObject<HTMLDivElement | null>; article: React.RefObject<HTMLElement | null>;
	content: string; highlights: ReadingHighlight[]; onSave: (highlights: ReadingHighlight[]) => Promise<void>; disabled: boolean;
}) {
	const controls = useRef<HTMLDivElement>(null), editing = useRef<Editing | null>(null), saving = useRef(false);
	const latest = useRef({ highlights, onSave, disabled });
	useLayoutEffect(() => { latest.current = { highlights, onSave, disabled }; }, [highlights, onSave, disabled]);
	const [draft, setDraft] = useState<Editing | null>(null), [geometry, setGeometry] = useState<Geometry | null>(null);
	const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
	const commands = useRef({ save: () => {}, remove: () => {} });
	const [layout, setLayout] = useState(0);

	useLayoutEffect(() => {
		const reader = article.current, text = body.current;
		if (!reader || !text || !draft) { setGeometry(null); return; }
		const range = highlightRange(text, draft.highlight);
		if (!range) { setGeometry(null); return; }
		const rects = highlightTextRects(text, draft.highlight);
		if (!rects.length) { setGeometry(null); return; }
		const bounds = reader.getBoundingClientRect();
		const convert = (rect: DOMRect): Box => ({ left: rect.left - bounds.left, top: rect.top - bounds.top + reader.scrollTop, width: rect.width, height: rect.height });
		// Nested inline elements can contribute identical rectangles. Paint each area once.
		const boxes = rects.filter((rect, index) => !rects.some((other, otherIndex) => otherIndex < index && other.left <= rect.left && other.right >= rect.right && other.top <= rect.top && other.bottom >= rect.bottom)).map(convert);
		const first = convert(rects[0]!), last = convert(rects.at(-1)!);
		const viewportBottom = Math.min(bounds.bottom, reader.ownerDocument.defaultView?.innerHeight ?? bounds.bottom);
		const navBottom = reader.querySelector('nav')?.getBoundingClientRect().bottom ?? bounds.top;
		const firstRect = rects[0]!, lastRect = rects.at(-1)!;
		// Leave 6px beyond the handle's 44px touch target, including at viewport edges.
		const beside = lastRect.right + 28 + 44 <= bounds.right - 12;
		const left = Math.max(12, Math.min(bounds.width - 56, lastRect.right - bounds.left + (beside ? 28 : -22)));
		const below = lastRect.bottom + 28;
		const desiredY = beside ? (lastRect.top + lastRect.bottom) / 2 - 22
			: below + 44 <= viewportBottom - 12 ? below : firstRect.top - 72;
		const menuY = Math.max(navBottom + 8, Math.min(viewportBottom - 56, desiredY));
		const feedbackY = menuY + 156 <= viewportBottom ? menuY + 52 : Math.max(navBottom + 8, menuY - 112);
		setGeometry({ boxes, start: first, end: last,
			menu: { left, top: menuY - bounds.top + reader.scrollTop },
			feedback: { left: Math.max(12, Math.min(bounds.width - 232, left)), top: feedbackY - bounds.top + reader.scrollTop },
		});
		const marks = Array.from(text.querySelectorAll<HTMLElement>('.crate-reading-reader__highlight')).filter(mark => draft.original && Number(mark.dataset.highlightStart) < draft.original.end && Number(mark.dataset.highlightEnd) > draft.original.start);
		for (const mark of marks) mark.classList.add('is-editing');
		return () => { for (const mark of marks) mark.classList.remove('is-editing'); };
	}, [article, body, content, highlights, draft, layout]);

	useEffect(() => {
		const reader = article.current, text = body.current;
		if (!reader || !text) return;
		const document = reader.ownerDocument, window = document.defaultView;
		if (!window) return;
		let alive = true, held = false, nativeIntent = false, timer = 0, frame = 0, suppressClickUntil = 0, retryRemove = false;
		let drag: { edge: 'start' | 'end'; pointer: number; initial: Editing; x: number; y: number; deltaY: number; target: HTMLElement } | null = null;
		const edit = (value: Editing | null) => { editing.current = value; setDraft(value); };
		const dismiss = () => { edit(null); setError(null); nativeIntent = false; window.clearTimeout(timer); };
		const persist = async (value: Editing, remove = false) => {
			if (saving.current) return;
			retryRemove = remove;
			if (latest.current.disabled) { setError('Waiting for your previous change to sync. Try again shortly.'); return; }
			saving.current = true; setBusy(true); setError(null);
			try {
				if (!highlightRange(text, value.highlight)) throw new Error('Article text changed. Select the passage again.');
				const next = latest.current.highlights.filter(entry => value.original
					? entry.end <= value.original.start || entry.start >= value.original.end
					: entry.start !== value.highlight.start || entry.end !== value.highlight.end);
				if (!remove) next.push(value.highlight);
				await latest.current.onSave(readingHighlights(next));
				if (!alive) return;
				if (editing.current === value) edit(remove ? null : { original: value.highlight, highlight: value.highlight });
			} catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : 'Could not save highlight.'); }
			finally { saving.current = false; if (alive) setBusy(false); }
		};
		commands.current = {
			save: () => { if (editing.current) void persist(editing.current, retryRemove); },
			remove: () => { if (editing.current) void persist(editing.current, true); },
		};
		const finishNativeSelection = () => {
			if (held || drag || !nativeIntent || saving.current) return;
			const highlight = selectedHighlight(text, document.getSelection());
			if (!highlight) return;
			nativeIntent = false; suppressClickUntil = Date.now() + 400;
			const value = { original: null, highlight }; edit(value);
			document.getSelection()?.removeAllRanges();
			void persist(value);
		};
		const settle = () => { window.clearTimeout(timer); timer = window.setTimeout(finishNativeSelection, 120); };
		const selectionChanged = () => { if (nativeIntent && !held) settle(); };
		const activate = (event: MouseEvent | KeyboardEvent) => {
			if ('key' in event && !['Enter', ' '].includes(event.key)) return;
			const mark = (event.target as HTMLElement).closest<HTMLElement>('.crate-reading-reader__highlight');
			if (!mark || !text.contains(mark)) return;
			if ((!('key' in event) && Date.now() < suppressClickUntil) || selectedHighlight(text, document.getSelection())) { event.preventDefault(); return; }
			event.preventDefault(); nativeIntent = false;
			const start = Number(mark.dataset.highlightStart), end = Number(mark.dataset.highlightEnd);
			const highlight = { start, end, text: (text.textContent ?? '').slice(start, end) };
			edit({ original: highlight, highlight }); setError(null);
		};
		const updateDrag = () => {
			if (!drag || !editing.current) return;
			const bounds = text.getBoundingClientRect(), viewport = reader.getBoundingClientRect();
			const navBottom = reader.querySelector('nav')?.getBoundingClientRect().bottom ?? viewport.top;
			const y = Math.max(navBottom + 2, Math.min(Math.min(viewport.bottom, window.innerHeight) - 2, drag.y + drag.deltaY));
			// Caret hit-testing must see the article under the moving handle's touch target.
			const overlay = controls.current;
			overlay?.classList.add('is-hit-testing');
			let offset: number | null;
			try { offset = highlightOffsetAtPoint(text, Math.max(bounds.left + 1, Math.min(bounds.right - 1, drag.x)), y); }
			finally { overlay?.classList.remove('is-hit-testing'); }
			if (offset !== null) edit({ ...editing.current, highlight: resizeHighlight(text.textContent ?? '', editing.current.highlight, drag.edge, offset) });
		};
		const autoScroll = () => {
			if (!drag) return;
			const bounds = reader.getBoundingClientRect(), top = reader.querySelector('nav')?.getBoundingClientRect().bottom ?? bounds.top;
			const bottom = Math.min(bounds.bottom, window.innerHeight);
			const delta = drag.y < top + 40 ? -8 : drag.y > bottom - 40 ? 8 : 0;
			if (delta) { reader.scrollTop += delta; updateDrag(); }
			frame = window.requestAnimationFrame(autoScroll);
		};
		const down = (event: PointerEvent) => {
			const target = event.target as HTMLElement;
			const handle = target.closest<HTMLElement>('[data-highlight-edge]');
			if (handle && controls.current?.contains(handle) && editing.current && !saving.current && !latest.current.disabled) {
				event.preventDefault(); nativeIntent = false; held = false;
				const edge = handle.dataset.highlightEdge as 'start' | 'end';
				const rect = highlightTextRects(text, editing.current.highlight);
				const endRect = edge === 'start' ? rect?.[0] : rect?.[rect.length - 1];
				drag = { edge, pointer: event.pointerId, initial: editing.current, x: event.clientX, y: event.clientY, deltaY: endRect ? (endRect.top + endRect.bottom) / 2 - event.clientY : 0, target: handle };
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
			if (cancel) edit(previous.initial);
			else if (editing.current) void persist(editing.current);
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
			const edge = (event.target as HTMLElement).dataset.highlightEdge as 'start' | 'end' | undefined;
			if (edge && editing.current && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !latest.current.disabled && !saving.current) {
				event.preventDefault(); const value = editing.current;
				edit({ ...value, highlight: resizeHighlight(text.textContent ?? '', value.highlight, edge, value.highlight[edge] + (event.key === 'ArrowLeft' ? -1 : 1)) });
			} else if (event.shiftKey && event.key.startsWith('Arrow') && !controls.current?.contains(event.target as Node)) nativeIntent = true;
		};
		const keyup = (event: KeyboardEvent) => {
			if ((event.target as HTMLElement).dataset.highlightEdge && event.key.startsWith('Arrow') && editing.current) void persist(editing.current);
			else settle();
		};
		const relayout = () => { setLayout(value => value + 1); };
		const blur = () => { held = false; nativeIntent = false; endDrag(true); };
		document.addEventListener('selectionchange', selectionChanged);
		document.addEventListener('pointerdown', down); document.addEventListener('pointermove', move, { passive: false });
		document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
		document.addEventListener('touchend', touchEnd, { passive: true }); document.addEventListener('touchcancel', touchCancel, { passive: true });
		document.addEventListener('keydown', keydown); document.addEventListener('keyup', keyup);
		text.addEventListener('click', activate); text.addEventListener('keydown', activate);
		reader.addEventListener('scroll', relayout); window.addEventListener('resize', relayout); window.addEventListener('blur', blur);
		return () => {
			alive = false; window.clearTimeout(timer); window.cancelAnimationFrame(frame);
			document.removeEventListener('selectionchange', selectionChanged);
			document.removeEventListener('pointerdown', down); document.removeEventListener('pointermove', move);
			document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
			document.removeEventListener('touchend', touchEnd); document.removeEventListener('touchcancel', touchCancel);
			document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup);
			text.removeEventListener('click', activate); text.removeEventListener('keydown', activate);
			reader.removeEventListener('scroll', relayout); window.removeEventListener('resize', relayout); window.removeEventListener('blur', blur);
		};
	}, [article, body]);

	return draft && geometry && <div ref={controls} className="crate-reading-reader__highlight-editor">
		<div aria-hidden="true">{geometry.boxes.map((box, index) => <span key={index} className="crate-reading-reader__highlight-preview" style={box} />)}</div>
		{(['start', 'end'] as const).map(edge => {
			const box = geometry[edge];
			return <button key={edge} type="button" className="crate-reading-reader__highlight-handle" data-highlight-edge={edge} aria-label={`Adjust highlight ${edge}`} disabled={busy || disabled}
				style={{ left: box.left + (edge === 'end' ? box.width : 0), top: box.top, '--highlight-line-height': `${box.height}px` } as React.CSSProperties} />;
		})}
		<div className="crate-reading-reader__selection" role="group" aria-label="Highlight actions" style={geometry.menu} onPointerDown={event => event.preventDefault()}>
			<IconButton className="crate-reading-reader__delete-highlight" icon="x" iconSize="l" size="large" variant="surface" tone="danger" label="Delete highlight" disabled={busy || disabled} onClick={() => commands.current.remove()} />
			{busy && <span className="crate-reading__sr-only" role="status">Saving highlight</span>}
		</div>
		{error && <div className="crate-reading-reader__highlight-error" style={geometry.feedback}><p role="alert">{error}</p><Button variant="ghost" disabled={busy || disabled} onClick={() => commands.current.save()}>Retry highlight</Button></div>}
	</div>;
}
