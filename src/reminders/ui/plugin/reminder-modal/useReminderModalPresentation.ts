import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isObsidianOverlayActive } from '../../../../ui/shared/useObsidianOverlayActive';
import type { RichTextInputHandle } from '../../shared/RichTextInput';
import { getReminderTitleCaret } from '../../reminder-editor/reminderEditorEdits';
import { saveCursorPosition } from '../../../../ui/shared/cursorPosition';

interface UseReminderModalPresentationOptions {
	focusDelayMs: number;
	onClose: () => void;
	richTextInputRef: RefObject<RichTextInputHandle | null>;
	projects: string[];
}

export function useReminderModalPresentation({
	focusDelayMs,
	onClose,
	richTextInputRef,
	projects,
}: UseReminderModalPresentationOptions) {
	const [currentView, setCurrentView] = useState<'main' | 'date' | 'project' | 'recurrence' | null>('main');
	const [isClosing, setIsClosing] = useState(false);
	const [showModal, setShowModal] = useState(true);
	const [isEntryAnimationComplete, setIsEntryAnimationComplete] = useState(false);
	const [allowAutoFocus, setAllowAutoFocus] = useState(focusDelayMs === 0);

	const hasClosedRef = useRef(false);
	const pickerCaretRef = useRef<{ content: string; caret: number | null; returning: boolean } | null>(null);
	const projectsRef = useRef(projects);
	projectsRef.current = projects;

	// Restore the caret from before a picker. If the picker rebuilt the text,
	// keep it within the user's words rather than among the chips after them.
	const focusInput = useCallback(() => {
		const input = richTextInputRef.current;
		const element = input?.getElement();
		if (!input || !element || !isObsidianOverlayActive(element)) return;
		const saved = pickerCaretRef.current?.returning ? pickerCaretRef.current : null;
		if (!saved) {
			input.focus();
			return;
		}
		const value = input.getValue();
		const limit = value === saved.content ? Infinity : getReminderTitleCaret(value, projectsRef.current);
		const offset = Math.min(saved.caret ?? Infinity, limit);
		input.focus(Number.isFinite(offset) ? { offset } : undefined);
	}, [richTextInputRef]);

	useEffect(() => {
		if (focusDelayMs === 0) {
			setAllowAutoFocus(true);
			return;
		}
		setAllowAutoFocus(false);
		const timer = window.setTimeout(() => {
			setAllowAutoFocus(true);
		}, focusDelayMs);
		return () => window.clearTimeout(timer);
	}, [focusDelayMs]);

	useEffect(() => {
		if (!allowAutoFocus || currentView !== 'main' || !showModal || isClosing) {
			return;
		}

		const frame = window.requestAnimationFrame(() => {
			focusInput();
			pickerCaretRef.current = null;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [allowAutoFocus, currentView, focusInput, isClosing, showModal]);

	const handleClose = useCallback(() => {
		if (isClosing) {
			return;
		}

		richTextInputRef.current?.blur();
		setIsClosing(true);
		setShowModal(false);
	}, [isClosing, richTextInputRef]);

	const handleModalExitComplete = useCallback(() => {
		if (!isClosing || hasClosedRef.current) {
			return;
		}

		hasClosedRef.current = true;
		onClose();
	}, [isClosing, onClose]);

	const transitionToView = useCallback((targetView: 'main' | 'date' | 'project' | 'recurrence') => {
		const input = richTextInputRef.current;
		pickerCaretRef.current = targetView === 'main' || !input ? null : {
			content: input.getValue(), caret: saveCursorPosition(input.getElement()), returning: false,
		};
		setCurrentView(targetView);
	}, [richTextInputRef]);

	const closePickerModal = useCallback(() => {
		if (pickerCaretRef.current) pickerCaretRef.current.returning = true;
		setCurrentView('main');
		queueMicrotask(focusInput);
	}, [focusInput]);

	const handleEntryAnimationComplete = useCallback(() => {
		setIsEntryAnimationComplete(true);
	}, []);

	return {
		currentView,
		isClosing,
		showModal,
		isEntryAnimationComplete,
		allowAutoFocus,
		handleClose,
		handleModalExitComplete,
		transitionToView,
		closePickerModal,
		handleEntryAnimationComplete,
	};
}
