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
	}, []);

	const handleEditorFieldFocus = useCallback(() => {
		if (keyboardDoneTimerRef.current !== null) {
			window.clearTimeout(keyboardDoneTimerRef.current);
			keyboardDoneTimerRef.current = null;
		}
	}, []);

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
		handleDescriptionFocus: handleEditorFieldFocus,
		handleEditorFieldBlur,
		handleTitleFocus: handleEditorFieldFocus,
	};
}
