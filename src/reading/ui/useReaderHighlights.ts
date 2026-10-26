import { useEffect, useRef, useState, type RefObject } from 'react';
import { readingDocument } from '../core/markdown';
import { anchorHighlight, writeMarkdownHighlights } from '../core/markdown-highlights';
import type { ReadingHighlight } from '../core/highlights';
import type { ReadingChanges, ReadingMetadata } from '../core/model';

type ReaderMode = 'article' | 'highlights';

interface ReaderHighlightsOptions {
	item: ReadingMetadata;
	markdown: string | null;
	/** Rendered article content; passages are focused again once it changes. */
	content: unknown;
	body: RefObject<HTMLDivElement | null>;
	article: RefObject<HTMLElement | null>;
	mode: ReaderMode;
	setMode: (mode: ReaderMode) => void;
	onUpdate?: (changes: ReadingChanges) => Promise<void>;
	focusHighlight?: ReadingHighlight;
	floatingHighlights: boolean;
	setError: (error: string | null) => void;
	disabled: boolean;
}

function findCurrent(item: ReadingMetadata, target: ReadingHighlight): ReadingHighlight | undefined {
	return item.highlights?.find(highlight => target.id ? highlight.id === target.id : highlight.start === target.start && highlight.end === target.end);
}

/** Highlight sheets, the note and delete dialogs, and passage focus for one open reading item. */
export function useReaderHighlights({ item, markdown, content, body, article, mode, setMode, onUpdate, focusHighlight, floatingHighlights, setError, disabled }: ReaderHighlightsOptions) {
	const [highlightsOpen, setHighlightsOpen] = useState(false);
	// An action chosen in the Highlights sheet runs once the sheet has closed.
	const sheetAction = useRef<(() => void) | null>(null);
	const targetAfterSheet = useRef(false);
	const [target, setTarget] = useState<ReadingHighlight | null>(null);
	const [annotation, setAnnotation] = useState<ReadingHighlight | null>(null), [note, setNote] = useState('');
	const [pendingDelete, setPendingDelete] = useState<ReadingHighlight | null>(null);
	// A note opened from the Highlights sheet stacks over it, so closing returns to the list.
	const [noteOverHighlights, setNoteOverHighlights] = useState(false);
	useEffect(() => {
		setAnnotation(null); setPendingDelete(null); setHighlightsOpen(false); sheetAction.current = null;
	}, [item.crate_reading_id]);
	useEffect(() => { if (focusHighlight) { setMode('article'); setTarget(focusHighlight); } }, [focusHighlight, setMode]);
	useEffect(() => {
		if (!target || mode !== 'article' || markdown === null) return;
		const ownerWindow = article.current?.ownerDocument.defaultView;
		if (!ownerWindow) return;
		const focusPassage = () => {
			const passage = body.current?.querySelector<HTMLElement>(`[data-highlight-start="${target.start}"]`);
			if (passage) {
				passage.focus({ preventScroll: true });
				passage.scrollIntoView({ block: 'center', behavior: floatingHighlights && !ownerWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
			}
			else setError('This passage changed. Find it in the article before highlighting again.');
			setTarget(null);
		};
		if (!targetAfterSheet.current) { focusPassage(); return; }
		// Let the closing sheet release its scroll lock and restore trigger focus first.
		const frame = ownerWindow.requestAnimationFrame(() => { targetAfterSheet.current = false; focusPassage(); });
		return () => ownerWindow.cancelAnimationFrame(frame);
	}, [target, mode, markdown, content, floatingHighlights, setError, article, body]);
	const saveHighlights = async (highlights: ReadingHighlight[]) => {
		if (!onUpdate || markdown === null) throw new Error('Open the article before saving highlights.');
		const document = readingDocument(markdown);
		if (body.current && document.text !== body.current.textContent) throw new Error('This article contains unsupported formatting. Edit its highlights in Obsidian.');
		const prepared = writeMarkdownHighlights(markdown, highlights.map(highlight => anchorHighlight(document.text, highlight)));
		await onUpdate({ highlights: prepared.highlights });
	};
	const saveNote = async () => {
		if (!annotation) return;
		const current = findCurrent(item, annotation);
		if (!current || current.text !== annotation.text || current.note !== annotation.note) throw new Error('This highlight changed elsewhere. Your note is still here; copy it before reopening the highlight.');
		await saveHighlights((item.highlights ?? []).map(highlight => highlight === current ? { ...highlight, note: note.trim() } : highlight));
	};
	const deleteHighlight = async (highlight: ReadingHighlight) => {
		const current = findCurrent(item, highlight);
		if (!current) throw new Error('This highlight changed elsewhere. Reopen the article and try again.');
		await saveHighlights((item.highlights ?? []).filter(existing => existing !== current));
	};
	const openNote = (highlight: ReadingHighlight, overHighlights = false) => { setError(null); setAnnotation(highlight); setNote(highlight.note ?? ''); setNoteOverHighlights(overHighlights); };
	/** Runs `action` now, or after `close` dismisses the Highlights sheet it came from. */
	const perform = (action: () => void, close?: () => void) => {
		if (close) { sheetAction.current = action; close(); } else action();
	};
	const view = (highlight: ReadingHighlight, close?: () => void) => perform(() => { targetAfterSheet.current = Boolean(close); setMode('article'); setTarget(highlight); }, close);
	const closeHighlights = () => {
		setHighlightsOpen(false);
		if (noteOverHighlights) setAnnotation(null);
		const action = sheetAction.current;
		sheetAction.current = null;
		action?.();
	};
	return {
		highlightsOpen, openHighlights: () => setHighlightsOpen(true), closeHighlights,
		annotation, note, setNote, noteOverHighlights, openNote, closeNote: () => setAnnotation(null),
		canSaveNote: Boolean(annotation) && !disabled && note.trim() !== (annotation?.note ?? ''),
		pendingDelete, requestDelete: (highlight: ReadingHighlight) => { setError(null); setPendingDelete(highlight); }, cancelDelete: () => setPendingDelete(null),
		saveHighlights, saveNote, deleteHighlight, perform, view,
	};
}
