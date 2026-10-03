import { readerScrollElement } from './reader-scroll';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { readingHighlights, type ReadingHighlight } from '../core/highlights';
import { highlightOffsetAtPoint, highlightRange, highlightTextRects, resizeHighlight, selectedHighlight } from './reader-highlights';

type Editing = { original: ReadingHighlight | null; highlight: ReadingHighlight };
type Box = { left: number; top: number; width: number; height: number };
type Geometry = { boxes: Box[]; start: Box; end: Box; menu: { left: number; top: number }; feedback: { left: number; top: number } };

/** Native initial selection; portable handles for editing a saved annotation. */
export function ReadingHighlightActions({ body, article, content, highlights, onSave, onCopyComplete, disabled }: {
	body: React.RefObject<HTMLDivElement | null>; article: React.RefObject<HTMLElement | null>;
	content: DocumentFragment | null; highlights: ReadingHighlight[]; onSave: (highlights: ReadingHighlight[]) => Promise<void>; disabled: boolean;
	onCopyComplete?: () => void;
}) {
	const controls = useRef<HTMLDivElement>(null), editing = useRef<Editing | null>(null), saving = useRef(false);
	const latest = useRef({ highlights, onSave, onCopyComplete, disabled });
	useLayoutEffect(() => { latest.current = { highlights, onSave, onCopyComplete, disabled }; }, [highlights, onSave, onCopyComplete, disabled]);
	const [draft, setDraft] = useState<Editing | null>(null), [geometry, setGeometry] = useState<Geometry | null>(null);
	const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
	const commands = useRef({ copy: () => {}, share: () => {}, save: () => {}, remove: () => {} });
	const [transferBusy, setTransferBusy] = useState(false);
	const [feedback, setFeedback] = useState<{ message: string; failed: boolean } | null>(null);
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
		const navBottom = Math.max(0, reader.querySelector('nav')?.getBoundingClientRect().bottom ?? bounds.top);
		const firstRect = rects[0]!, lastRect = rects.at(-1)!;
		// Center the action over the passage instead of trailing its final line.
		// Keep the toolbar close, with extra clearance only where it crosses a handle.
		const passageLeft = Math.min(...rects.map(rect => rect.left));
		const passageRight = Math.max(...rects.map(rect => rect.right));
		const left = Math.max(12, Math.min(bounds.width - 220, (passageLeft + passageRight) / 2 - bounds.left - 104));
		const clearsHandles = [firstRect.left, lastRect.right].every(x => x + 22 <= bounds.left + left || x - 22 >= bounds.left + left + 208);
		const gap = clearsHandles ? 8 : 28;
		const above = firstRect.top - 52 - gap;
		const below = lastRect.bottom + gap;
		const headerBottom = reader.querySelector('.crate-reading-reader__header')?.getBoundingClientRect().bottom ?? navBottom;
		const desiredY = above >= Math.max(navBottom, headerBottom) + 8 ? above : below;
		const menuY = Math.max(navBottom + 8, Math.min(viewportBottom - 64, desiredY));
		const feedbackY = menuY + 156 <= viewportBottom ? menuY + 60 : Math.max(navBottom + 8, menuY - 112);
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
		let alive = true, held = false, nativeIntent = false, timer = 0, frame = 0, suppressClickUntil = 0, retryRemove = false, transferring = false;
		let drag: { edge: 'start' | 'end'; pointer: number; initial: Editing; x: number; y: number; deltaY: number; target: HTMLElement } | null = null;
		const eventTarget = (event: Event) => (event.composedPath()[0] ?? event.target) as HTMLElement;
		const activeElement = () => {
			let active = document.activeElement;
			while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
			return active;
		};
		const edit = (value: Editing | null) => { editing.current = value; setDraft(value); };
		const dismiss = () => { edit(null); setError(null); setFeedback(null); nativeIntent = false; window.clearTimeout(timer); };
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
				const previous = value.original && latest.current.highlights.find(entry => entry.start === value.original!.start && entry.end === value.original!.end);
				if (!remove) next.push({ ...previous, ...value.highlight });
				await latest.current.onSave(readingHighlights(next));
				if (!alive) return;
				if (editing.current === value) edit(remove ? null : { original: value.highlight, highlight: value.highlight });
			} catch (cause) { if (alive && editing.current === value) setError(cause instanceof Error ? cause.message : 'Could not save highlight.'); }
			finally { saving.current = false; if (alive) setBusy(false); }
		};
		const transfer = async (share: boolean) => {
			const value = editing.current;
			if (!value || transferring) return;
			transferring = true; setTransferBusy(true); setFeedback(null);
			const current = () => alive && editing.current?.highlight === value.highlight;
			try {
				// Invoke directly from the button press, before awaiting anything else.
				if (share && window.navigator.share) {
					await window.navigator.share({ text: value.highlight.text });
				} else {
					if (!window.navigator.clipboard) throw new Error('Clipboard unavailable');
					await window.navigator.clipboard.writeText(value.highlight.text);
					if (current()) {
						if (!share && latest.current.onCopyComplete) {
							dismiss();
							latest.current.onCopyComplete();
						} else setFeedback({ message: share ? 'Sharing unavailable. Text copied.' : 'Text copied.', failed: false });
					}
				}
			} catch (cause) {
				if (current() && !(share && cause instanceof Error && cause.name === 'AbortError')) {
					setFeedback({ message: share ? 'Could not share text. Try Copy instead.' : 'Could not copy text. Try again.', failed: true });
				}
			} finally { transferring = false; if (alive) setTransferBusy(false); }
		};
		commands.current = {
			copy: () => { void transfer(false); },
			share: () => { void transfer(true); },
			save: () => { if (editing.current) void persist(editing.current, retryRemove); },
			remove: () => { if (editing.current) void persist(editing.current, true); },
		};
		const finishNativeSelection = () => {
			if (held || drag || !nativeIntent || saving.current || controls.current?.contains(activeElement())) return;
			const highlight = selectedHighlight(text);
			if (!highlight) return;
			nativeIntent = false; suppressClickUntil = Date.now() + 400;
			const original = latest.current.highlights.find(entry => entry.start === highlight.start && entry.end === highlight.end) ?? null;
			const value = { original, highlight }; edit(value); setError(null); setFeedback(null);
			document.getSelection()?.removeAllRanges();
			if (!original) void persist(value);
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
			edit({ original: highlight, highlight }); setError(null); setFeedback(null);
		};
		const updateDrag = () => {
			if (!drag || !editing.current) return;
			const bounds = text.getBoundingClientRect(), viewport = reader.getBoundingClientRect();
			const navBottom = Math.max(0, reader.querySelector('nav')?.getBoundingClientRect().bottom ?? viewport.top);
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
			const bounds = reader.getBoundingClientRect(), top = Math.max(0, reader.querySelector('nav')?.getBoundingClientRect().bottom ?? bounds.top);
			const bottom = Math.min(bounds.bottom, window.innerHeight);
			const delta = drag.y < top + 40 ? -8 : drag.y > bottom - 40 ? 8 : 0;
			if (delta) { readerScrollElement(reader).scrollTop += delta; updateDrag(); }
			frame = window.requestAnimationFrame(autoScroll);
		};
		const down = (event: PointerEvent) => {
			if (event.button !== 0) return;
			const target = eventTarget(event);
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
			const edge = eventTarget(event).dataset.highlightEdge as 'start' | 'end' | undefined;
			if (edge && editing.current && ['ArrowLeft', 'ArrowRight'].includes(event.key) && !latest.current.disabled && !saving.current) {
				event.preventDefault(); const value = editing.current;
				edit({ ...value, highlight: resizeHighlight(text.textContent ?? '', value.highlight, edge, value.highlight[edge] + (event.key === 'ArrowLeft' ? -1 : 1)) });
			} else if (event.shiftKey && event.key.startsWith('Arrow') && !controls.current?.contains(eventTarget(event))) nativeIntent = true;
		};
		const keyup = (event: KeyboardEvent) => {
			if (eventTarget(event).dataset.highlightEdge && event.key.startsWith('Arrow') && editing.current) void persist(editing.current);
			else settle();
		};
		const relayout = () => { setLayout(value => value + 1); };
		const scroll = (event: Event) => {
			if (event.target !== document && event.target !== document.scrollingElement && !reader.contains(eventTarget(event))) return;
			// Handle auto-scroll is part of resizing, not a request to dismiss it.
			if (drag) relayout();
			else if (editing.current) dismiss();
		};
		const blur = () => { held = false; nativeIntent = false; endDrag(true); };
		document.addEventListener('selectionchange', selectionChanged);
		document.addEventListener('pointerdown', down); document.addEventListener('pointermove', move, { passive: false });
		document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
		document.addEventListener('touchend', touchEnd, { passive: true }); document.addEventListener('touchcancel', touchCancel, { passive: true });
		document.addEventListener('keydown', keydown); document.addEventListener('keyup', keyup);
		text.addEventListener('click', activate); text.addEventListener('keydown', activate);
		document.addEventListener('scroll', scroll, true); window.addEventListener('resize', relayout); window.addEventListener('blur', blur);
		return () => {
			alive = false; window.clearTimeout(timer); window.cancelAnimationFrame(frame);
			document.removeEventListener('selectionchange', selectionChanged);
			document.removeEventListener('pointerdown', down); document.removeEventListener('pointermove', move);
			document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
			document.removeEventListener('touchend', touchEnd); document.removeEventListener('touchcancel', touchCancel);
			document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup);
			text.removeEventListener('click', activate); text.removeEventListener('keydown', activate);
			document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', relayout); window.removeEventListener('blur', blur);
		};
	}, [article, body]);

	return draft && geometry && <div ref={controls} className="crate-reading-reader__highlight-editor">
		<div aria-hidden="true">{geometry.boxes.map((box, index) => <span key={index} className="crate-reading-reader__highlight-preview" style={box} />)}</div>
		{(['start', 'end'] as const).map(edge => {
			const box = geometry[edge];
			return <button key={edge} type="button" className="crate-reading-reader__highlight-handle" data-highlight-edge={edge} aria-label={`Adjust highlight ${edge}`} disabled={busy || disabled}
				style={{ left: box.left + (edge === 'end' ? box.width : 0), top: box.top, '--highlight-line-height': `${box.height}px` } as React.CSSProperties} />;
		})}
		<div className="crate-reading-reader__selection" role="group" aria-label="Highlight actions" style={geometry.menu}>
			<Button variant="ghost" aria-label="Copy text" disabled={transferBusy} onClick={() => commands.current.copy()}>Copy</Button>
			<Button variant="ghost" aria-label="Share text" disabled={transferBusy} onClick={() => commands.current.share()}>Share</Button>
			<span className="crate-reading-reader__selection-divider" aria-hidden="true" />
			<IconButton className="crate-reading-reader__delete-highlight" icon="trash-2" size="large" variant="surface" tone="danger" label="Delete highlight" disabled={busy || disabled} onClick={() => commands.current.remove()} />
			{busy && <span className="crate-reading__sr-only" role="status">Saving highlight</span>}
		</div>
		{feedback && !error && <div className="crate-reading-reader__highlight-error" style={geometry.feedback}><p role={feedback.failed ? 'alert' : 'status'}>{feedback.message}</p></div>}
		{error && <div className="crate-reading-reader__highlight-error" style={geometry.feedback}><p role="alert">{error}</p><Button variant="ghost" disabled={busy || disabled} onClick={() => commands.current.save()}>Retry highlight</Button></div>}
	</div>;
}
