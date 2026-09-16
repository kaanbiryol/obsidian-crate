import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { captureTitleSelection, restoreTitleSelection, revealTitleCaret } from '../editor-selection';

export function useEditorFocus({ titleRef, descriptionRef, editorRef, active, keyboardInset }: {
	titleRef: RefObject<HTMLDivElement | null>;
	descriptionRef: RefObject<HTMLTextAreaElement | null>;
	editorRef: RefObject<HTMLDivElement | null>;
	active: boolean;
	keyboardInset: number;
}) {
	const savedRef = useRef<{
		field: 'title' | 'description';
		titleSelection: ReturnType<typeof captureTitleSelection>;
		descriptionSelection: [number, number, 'forward' | 'backward' | 'none'];
		titleScroll: number;
		descriptionScroll: number;
		bodyScroll: number;
	} | null>(null);
	const restoringRef = useRef(false);
	const body = useCallback(() => editorRef.current?.querySelector<HTMLElement>('.reminder-modal-body') ?? null, [editorRef]);
	const restoreScroll = useCallback(() => {
		const saved = savedRef.current;
		if (!saved) return;
		if (titleRef.current) titleRef.current.scrollTop = saved.titleScroll;
		if (descriptionRef.current) descriptionRef.current.scrollTop = saved.descriptionScroll;
		const scroller = body();
		if (scroller) scroller.scrollTop = saved.bodyScroll;
	}, [body, descriptionRef, titleRef]);
	const rememberFocus = useCallback(() => {
		const title = titleRef.current;
		const description = descriptionRef.current;
		if (!title || !description) return;
		const descriptionFocused = description.matches(':focus');
		if (!descriptionFocused && !title.matches(':focus')) return;
		savedRef.current = {
			field: descriptionFocused ? 'description' : 'title',
			titleSelection: captureTitleSelection(title),
			descriptionSelection: [description.selectionStart, description.selectionEnd, description.selectionDirection],
			titleScroll: title.scrollTop, descriptionScroll: description.scrollTop,
			bodyScroll: body()?.scrollTop ?? 0,
		};
	}, [body, descriptionRef, titleRef]);

	const restoreFocus = useCallback(() => {
		const title = titleRef.current;
		const description = descriptionRef.current;
		if (!title || !description) return;
		const saved = savedRef.current;
		restoringRef.current = true;
		// This runs synchronously inside the picker tap so iOS can reopen its keyboard.
		if (saved?.field === 'description') {
			description.focus({ preventScroll: true });
			description.setSelectionRange(...saved.descriptionSelection);
		} else {
			title.focus({ preventScroll: true });
			restoreTitleSelection(title, saved?.titleSelection ?? null);
		}
		restoreScroll();
	}, [descriptionRef, restoreScroll, titleRef]);

	useLayoutEffect(() => {
		const title = titleRef.current;
		if (!active || !title) return;
		const ownerDocument = title.ownerDocument;
		const ownerWindow = ownerDocument.defaultView;
		if (!ownerWindow) return;
		let frame = 0;
		let lastSelection = captureTitleSelection(title);
		const reveal = () => {
			if (title.matches(':focus')) revealTitleCaret(title, body());
		};
		const scheduleReveal = () => {
			ownerWindow.cancelAnimationFrame(frame);
			frame = ownerWindow.requestAnimationFrame(reveal);
		};
		const selectionChanged = () => {
			const next = captureTitleSelection(title);
			if (next?.start === lastSelection?.start && next?.end === lastSelection?.end) return;
			lastSelection = next;
			scheduleReveal();
		};
		if (restoringRef.current) {
			restoringRef.current = false;
			restoreScroll();
		} else reveal();
		ownerDocument.addEventListener('selectionchange', selectionChanged);
		title.addEventListener('input', scheduleReveal);
		let initialResize = true;
		const observer = new ResizeObserver(() => {
			if (!initialResize) scheduleReveal();
			initialResize = false;
		});
		observer.observe(title);
		const scroller = body();
		if (scroller) observer.observe(scroller);
		return () => {
			ownerWindow.cancelAnimationFrame(frame);
			observer.disconnect();
			ownerDocument.removeEventListener('selectionchange', selectionChanged);
			title.removeEventListener('input', scheduleReveal);
		};
	}, [active, body, keyboardInset, restoreScroll, titleRef]);

	return { rememberFocus, restoreFocus };
}
