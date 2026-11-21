import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { PWA_CONTROL_SPRING, PWA_FADE, PWA_SURFACE_SPRING } from '../../ui/shared/navigation/motion';
import { readingHighlights, sameHighlight, type ReadingHighlight } from '../core/highlights';
import { highlightRange, highlightTextRects } from './reader-highlights';
import { readingHighlightGeometry, type HighlightGeometry } from './reading-highlight-geometry';
import { registerReadingHighlightInteraction, type HighlightEdit } from './reading-highlight-interaction';
import { PresenceSurface } from './PresenceSurface';

/** Native initial selection; portable handles for editing a saved annotation. */
export function ReadingHighlightActions({ body, article, content, highlights, onSave, onAnnotate, onCopyComplete, onSelect, onFeedback, disabled }: {
	body: React.RefObject<HTMLDivElement | null>; article: React.RefObject<HTMLElement | null>;
	content: DocumentFragment | null; highlights: ReadingHighlight[]; onSave: (highlights: ReadingHighlight[]) => Promise<void>; disabled: boolean;
	/** Opens the note editor for a saved highlight. */
	onAnnotate: (highlight: ReadingHighlight) => void;
	onCopyComplete?: () => void; onSelect?: (highlight: ReadingHighlight) => void;
	/** Host toast or notice for save, copy and share outcomes. */
	onFeedback?: (kind: 'success' | 'error', message: string) => void;
}) {
	const controls = useRef<HTMLDivElement>(null), editing = useRef<HighlightEdit | null>(null), saving = useRef(false);
	const latest = useRef({ highlights, onSave, onAnnotate, onCopyComplete, onSelect, onFeedback, disabled });
	useLayoutEffect(() => { latest.current = { highlights, onSave, onAnnotate, onCopyComplete, onSelect, onFeedback, disabled }; }, [highlights, onSave, onAnnotate, onCopyComplete, onSelect, onFeedback, disabled]);
	const [draft, setDraft] = useState<HighlightEdit | null>(null), [geometry, setGeometry] = useState<HighlightGeometry | null>(null);
	const [busy, setBusy] = useState(false);
	// A save or delete that failed offers Retry in place of Note until it succeeds or the edit changes.
	const [failed, setFailed] = useState(false);
	const commands = useRef({ copy: () => {}, share: () => {}, highlight: () => {}, annotate: () => {}, remove: () => {}, retry: () => {} });
	const [transferBusy, setTransferBusy] = useState(false);
	const [layout, setLayout] = useState(0);

	useLayoutEffect(() => {
		const reader = article.current, text = body.current;
		if (!reader || !text || !draft) { setGeometry(null); return; }
		const range = highlightRange(text, draft.highlight);
		if (!range) { setGeometry(null); return; }
		const rects = highlightTextRects(text, draft.highlight);
		if (!rects.length) { setGeometry(null); return; }
		const bounds = reader.getBoundingClientRect();
		setGeometry(readingHighlightGeometry({
			rects, bounds, scrollTop: reader.scrollTop,
			viewportHeight: reader.ownerDocument.defaultView?.innerHeight ?? bounds.bottom,
			navigationBottom: reader.querySelector('nav')?.getBoundingClientRect().bottom,
			headingBottom: reader.querySelector('.crate-reading-reader__header')?.getBoundingClientRect().bottom,
		}));
		const marks = Array.from(text.querySelectorAll<HTMLElement>('.crate-reading-reader__highlight')).filter(mark => draft.original && Number(mark.dataset.highlightStart) < draft.original.end && Number(mark.dataset.highlightEnd) > draft.original.start);
		for (const mark of marks) mark.classList.add('is-editing');
		return () => { for (const mark of marks) mark.classList.remove('is-editing'); };
	}, [article, body, content, highlights, draft, layout]);

	useEffect(() => {
		const reader = article.current, text = body.current;
		if (!reader || !text) return;
		const document = reader.ownerDocument, window = document.defaultView;
		if (!window) return;
		let alive = true, transferring = false, failedRemove = false;
		const edit = (value: HighlightEdit | null) => { editing.current = value; setDraft(value); };
		const fail = (message: string) => latest.current.onFeedback?.('error', message);
		const clearFailure = () => { failedRemove = false; setFailed(false); };
		const persistFailed = (remove: boolean, message: string) => { failedRemove = remove; setFailed(true); fail(message); };
		const persist = async (value: HighlightEdit, remove = false) => {
			if (saving.current) return;
			if (latest.current.disabled) { persistFailed(remove, 'Waiting for your previous change to sync. Try again shortly.'); return; }
			saving.current = true; setBusy(true); clearFailure();
			try {
				if (!highlightRange(text, value.highlight)) throw new Error('Article text changed. Select the passage again.');
				const { original, highlight } = value;
				// An image highlight replaces only itself; a passage replaces the text highlights it overlapped.
				const next = latest.current.highlights.filter(entry => highlight.image !== undefined || entry.image !== undefined
					? !sameHighlight(entry, original ?? highlight)
					: original ? entry.end <= original.start || entry.start >= original.end : !sameHighlight(entry, highlight));
				const previous = original && latest.current.highlights.find(entry => sameHighlight(entry, original));
				if (!remove) next.push({ ...previous, ...value.highlight });
				await latest.current.onSave(readingHighlights(next));
				if (!alive) return;
				if (editing.current === value) edit(remove ? null : { original: value.highlight, highlight: value.highlight });
			} catch (cause) { if (alive && editing.current === value) persistFailed(remove, cause instanceof Error ? cause.message : 'Could not save highlight.'); }
			finally { saving.current = false; if (alive) setBusy(false); }
		};
		const transfer = async (share: boolean) => {
			const value = editing.current;
			if (!value || transferring) return;
			transferring = true; setTransferBusy(true);
			const current = () => alive && editing.current?.highlight === value.highlight;
			try {
				// Invoke directly from the button press, before awaiting anything else.
				if (share) {
					await window.navigator.share({ text: value.highlight.text });
				} else {
					if (!window.navigator.clipboard) throw new Error('Clipboard unavailable');
					await window.navigator.clipboard.writeText(value.highlight.text);
					if (current()) {
						if (!share && latest.current.onCopyComplete) {
							dismiss();
							latest.current.onCopyComplete();
						} else latest.current.onFeedback?.('success', 'Text copied.');
					}
				}
			} catch (cause) {
				if (current() && !(share && cause instanceof Error && cause.name === 'AbortError')) {
					fail(share ? 'Could not share text. Try Copy instead.' : 'Could not copy text. Try again.');
				}
			} finally { transferring = false; if (alive) setTransferBusy(false); }
		};
		commands.current = {
			copy: () => { void transfer(false); },
			share: () => { void transfer(true); },
			highlight: () => { if (editing.current) void persist(editing.current); },
			annotate: () => {
				const value = editing.current;
				if (!value || saving.current) return;
				const saved = savedHighlight(latest.current.highlights, value.highlight);
				if (!saved) { fail('Save this highlight before adding a note.'); return; }
				dismiss();
				latest.current.onAnnotate(saved);
			},
			remove: () => { if (editing.current) void persist(editing.current, true); },
			retry: () => { if (editing.current) void persist(editing.current, failedRemove); },
		};
		const interaction = registerReadingHighlightInteraction({
			reader, text, controls,
			getState: () => ({ editing: editing.current, saving: saving.current, ...latest.current }),
			edit,
			select: value => { edit(value); clearFailure(); },
			onSelect: highlight => latest.current.onSelect?.(highlight),
			persist: value => { void persist(value); },
			onDismiss: () => { edit(null); clearFailure(); },
			relayout: () => setLayout(value => value + 1),
		});
		function dismiss() { interaction.dismiss(); }
		return () => { alive = false; interaction.dispose(); };
	}, [article, body]);

	const saved = draft && savedHighlight(highlights, draft.highlight), note = saved?.note;
	const image = draft?.highlight.image !== undefined;
	// Obsidian desktop has no native share sheet, so offer Copy only.
	const canShare = typeof article.current?.ownerDocument.defaultView?.navigator.share === 'function';
	const reduceMotion = useReducedMotion();
	// The editor fades as one surface; the toolbar also grows from the edge facing the passage.
	// Moving between highlights or dragging a handle keeps it mounted, so only show and hide animate.
	const toolbarMotion = {
		hidden: { scale: reduceMotion ? 1 : .9, transition: PWA_SURFACE_SPRING },
		shown: { scale: 1, transition: PWA_CONTROL_SPRING },
	};
	return <AnimatePresence>{draft && geometry && <PresenceSurface key="editor" ref={controls} className="crate-reading-reader__highlight-editor"
		variants={{ hidden: { opacity: 0, transition: PWA_FADE }, shown: { opacity: 1, transition: PWA_FADE } }} initial="hidden" animate="shown" exit="hidden">
		<div aria-hidden="true">{geometry.boxes.map((box, index) => <span key={index} className="crate-reading-reader__highlight-preview" style={box} />)}</div>
		{!image && (['start', 'end'] as const).map(edge => {
			const box = geometry[edge];
			return <button key={edge} type="button" className="crate-reading-reader__highlight-handle" data-highlight-edge={edge} aria-label={`Adjust highlight ${edge}`} disabled={busy || disabled}
				style={{ left: box.left + (edge === 'end' ? box.width : 0), top: box.top, '--highlight-line-height': `${box.height}px` } as React.CSSProperties} />;
		})}
		<motion.div className="crate-reading-reader__selection" role="group" aria-label="Highlight actions" variants={toolbarMotion}
			style={{ ...geometry.menu, transformOrigin: geometry.menu.top < geometry.start.top ? 'center bottom' : 'center top' }}>
			{!image && <Button variant="ghost" aria-label="Copy text" disabled={transferBusy} onClick={() => commands.current.copy()}>Copy</Button>}
			{!image && canShare && <Button variant="ghost" aria-label="Share text" disabled={transferBusy} onClick={() => commands.current.share()}>Share</Button>}
			{image && !saved && !failed
				? <Button variant="ghost" aria-label="Highlight image" disabled={busy || disabled} onClick={() => commands.current.highlight()}>Highlight</Button>
				: failed
				? <Button variant="ghost" aria-label="Retry highlight" disabled={busy || disabled} onClick={() => commands.current.retry()}>Retry</Button>
				: <Button variant="ghost" aria-label={note ? 'Edit highlight note' : 'Add highlight note'} disabled={busy || disabled} onClick={() => commands.current.annotate()}>Note</Button>}
			{(!image || saved) && <span className="crate-reading-reader__selection-divider" aria-hidden="true" />}
			{(!image || saved) && <IconButton className="crate-reading-reader__delete-highlight" icon="trash-2" size="large" variant="surface" tone="danger" label="Delete highlight" disabled={busy || disabled} onClick={() => commands.current.remove()} />}
			{busy && <span className="crate-reading__sr-only" role="status">Saving highlight</span>}
		</motion.div>
	</PresenceSurface>}</AnimatePresence>;
}

function savedHighlight(highlights: ReadingHighlight[], highlight: ReadingHighlight): ReadingHighlight | undefined {
	return highlights.find(entry => sameHighlight(entry, highlight));
}
