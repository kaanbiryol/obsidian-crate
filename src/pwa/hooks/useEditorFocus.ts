import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { captureTitleSelection, restoreTitleSelection, revealTitleCaret } from '../editor-selection';

export function useEditorFocus({ titleRef, descriptionRef, editorRef, active, keyboardInset }: {
	titleRef: RefObject<HTMLDivElement | null>;
	descriptionRef: RefObject<HTMLDivElement | null>;
	editorRef: RefObject<HTMLDivElement | null>;
	active: boolean;
	keyboardInset: number;
}) {
	const savedRef = useRef<{
		field: 'title' | 'description';
		titleSelection: ReturnType<typeof captureTitleSelection>;
		descriptionSelection: ReturnType<typeof captureTitleSelection>;
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
			descriptionSelection: captureTitleSelection(description),
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
			restoreTitleSelection(description, saved.descriptionSelection);
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
		const fields = [title, descriptionRef.current].filter((field): field is HTMLDivElement => field !== null);
		const activeField = () => fields.find(field => field.matches(':focus')) ?? title;
		let lastSelection = captureTitleSelection(activeField());
		const reveal = () => {
			const field = activeField();
			if (field.matches(':focus')) revealTitleCaret(field, body());
		};
		const scheduleReveal = () => {
			ownerWindow.cancelAnimationFrame(frame);
			frame = ownerWindow.requestAnimationFrame(reveal);
		};
		const selectionChanged = () => {
			const next = captureTitleSelection(activeField());
			if (next?.start === lastSelection?.start && next?.end === lastSelection?.end) return;
			lastSelection = next;
			scheduleReveal();
		};
		if (restoringRef.current) {
			restoringRef.current = false;
			restoreScroll();
		} else reveal();
		ownerDocument.addEventListener('selectionchange', selectionChanged);
		fields.forEach(field => field.addEventListener('input', scheduleReveal));
		let initialResize = true;
		const observer = new ResizeObserver(() => {
			if (!initialResize) scheduleReveal();
			initialResize = false;
		});
		fields.forEach(field => observer.observe(field));
		const scroller = body();
		if (scroller) observer.observe(scroller);
		return () => {
			ownerWindow.cancelAnimationFrame(frame);
			observer.disconnect();
			ownerDocument.removeEventListener('selectionchange', selectionChanged);
			fields.forEach(field => field.removeEventListener('input', scheduleReveal));
		};
	}, [active, body, descriptionRef, keyboardInset, restoreScroll, titleRef]);

	return { rememberFocus, restoreFocus };
}
