import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { readingHighlights, type ReadingHighlight } from '../core/highlights';
import { highlightRange, highlightTextRects } from './reader-highlights';
import { readingHighlightGeometry, type HighlightGeometry } from './reading-highlight-geometry';
import { registerReadingHighlightInteraction, type HighlightEdit } from './reading-highlight-interaction';

/** Native initial selection; portable handles for editing a saved annotation. */
export function ReadingHighlightActions({ body, article, content, highlights, onSave, onCopyComplete, onSelect, disabled }: {
	body: React.RefObject<HTMLDivElement | null>; article: React.RefObject<HTMLElement | null>;
	content: DocumentFragment | null; highlights: ReadingHighlight[]; onSave: (highlights: ReadingHighlight[]) => Promise<void>; disabled: boolean;
	onCopyComplete?: () => void; onSelect?: (highlight: ReadingHighlight) => void;
}) {
	const controls = useRef<HTMLDivElement>(null), editing = useRef<HighlightEdit | null>(null), saving = useRef(false);
	const latest = useRef({ highlights, onSave, onCopyComplete, onSelect, disabled });
	useLayoutEffect(() => { latest.current = { highlights, onSave, onCopyComplete, onSelect, disabled }; }, [highlights, onSave, onCopyComplete, onSelect, disabled]);
	const [draft, setDraft] = useState<HighlightEdit | null>(null), [geometry, setGeometry] = useState<HighlightGeometry | null>(null);
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
		let alive = true, retryRemove = false, transferring = false;
		const edit = (value: HighlightEdit | null) => { editing.current = value; setDraft(value); };
		const clearFeedback = () => { setError(null); setFeedback(null); };
		const persist = async (value: HighlightEdit, remove = false) => {
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
		const interaction = registerReadingHighlightInteraction({
			reader, text, controls,
			getState: () => ({ editing: editing.current, saving: saving.current, ...latest.current }),
			edit,
			select: value => { edit(value); clearFeedback(); },
			onSelect: highlight => latest.current.onSelect?.(highlight),
			persist: value => { void persist(value); },
			onDismiss: () => { edit(null); clearFeedback(); },
			relayout: () => setLayout(value => value + 1),
		});
		function dismiss() { interaction.dismiss(); }
		return () => { alive = false; interaction.dispose(); };
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
