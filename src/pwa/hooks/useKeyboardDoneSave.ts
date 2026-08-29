import { useCallback, useEffect, useRef, type FocusEvent, type RefObject } from 'react';
import type { RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { shouldSaveFromKeyboardDone } from '../keyboard-done-save';

export function useKeyboardDoneSave({
	canSubmit,
	contentRef,
	descriptionRef,
	richTextInputRef,
	onSave,
}: {
	canSubmit: boolean;
	contentRef: RefObject<HTMLDivElement | null>;
	descriptionRef: RefObject<HTMLTextAreaElement | null>;
	richTextInputRef: RefObject<RichTextInputHandle | null>;
	onSave: () => void;
}) {
	const keyboardDoneTimerRef = useRef<number | null>(null);
	const titleFocusFrameRef = useRef<number | null>(null);
	const lastFocusedEditorFieldRef = useRef<'title' | 'description' | null>(null);
	const lastPagePointerAtRef = useRef(Number.NEGATIVE_INFINITY);
	const suppressKeyboardDoneSaveRef = useRef(false);

	useEffect(() => {
		const recordPagePointer = () => {
			lastPagePointerAtRef.current = performance.now();
		};
		document.addEventListener('pointerdown', recordPagePointer, true);
		return () => document.removeEventListener('pointerdown', recordPagePointer, true);
	}, []);

	useEffect(() => () => {
		if (keyboardDoneTimerRef.current !== null) {
			window.clearTimeout(keyboardDoneTimerRef.current);
		}
		if (titleFocusFrameRef.current !== null) {
			window.cancelAnimationFrame(titleFocusFrameRef.current);
		}
	}, []);

	const handleEditorFieldFocus = useCallback(() => {
		if (keyboardDoneTimerRef.current !== null) {
			window.clearTimeout(keyboardDoneTimerRef.current);
			keyboardDoneTimerRef.current = null;
		}
	}, []);

	const handleTitleFocus = useCallback(() => {
		handleEditorFieldFocus();
		const shouldMoveToEnd = lastFocusedEditorFieldRef.current === 'description';
		lastFocusedEditorFieldRef.current = 'title';
		if (!shouldMoveToEnd) return;

		if (titleFocusFrameRef.current !== null) {
			window.cancelAnimationFrame(titleFocusFrameRef.current);
		}
		titleFocusFrameRef.current = window.requestAnimationFrame(() => {
			titleFocusFrameRef.current = null;
			const titleElement = richTextInputRef.current?.getElement();
			if (!titleElement?.matches(':focus')) return;
			richTextInputRef.current?.focus();
		});
	}, [handleEditorFieldFocus, richTextInputRef]);

	const handleDescriptionFocus = useCallback(() => {
		handleEditorFieldFocus();
		lastFocusedEditorFieldRef.current = 'description';
	}, [handleEditorFieldFocus]);

	const handleEditorFieldBlur = useCallback((event: FocusEvent<HTMLElement>) => {
		const relatedTargetWasNull = event.relatedTarget === null;
		const hadRecentPagePointer = performance.now() - lastPagePointerAtRef.current < 750;
		if (keyboardDoneTimerRef.current !== null) {
			window.clearTimeout(keyboardDoneTimerRef.current);
		}
		keyboardDoneTimerRef.current = window.setTimeout(() => {
			keyboardDoneTimerRef.current = null;
			const hasEditorFocus = Boolean(
				contentRef.current?.matches(':focus') || descriptionRef.current?.matches(':focus'),
			);
			if (suppressKeyboardDoneSaveRef.current || !shouldSaveFromKeyboardDone({
				canSubmit,
				documentHasFocus: document.hasFocus(),
				documentIsVisible: document.visibilityState === 'visible',
				hadRecentPagePointer,
				hasEditorFocus,
				relatedTargetWasNull,
			})) return;
			onSave();
		}, 0);
	}, [canSubmit, contentRef, descriptionRef, onSave]);

	const dismissEditorKeyboard = useCallback(() => {
		suppressKeyboardDoneSaveRef.current = true;
		richTextInputRef.current?.getElement()?.blur();
		descriptionRef.current?.blur();
		window.setTimeout(() => {
			suppressKeyboardDoneSaveRef.current = false;
		}, 0);
	}, [descriptionRef, richTextInputRef]);

	return {
		dismissEditorKeyboard,
		handleDescriptionFocus,
		handleEditorFieldBlur,
		handleTitleFocus,
	};
}
