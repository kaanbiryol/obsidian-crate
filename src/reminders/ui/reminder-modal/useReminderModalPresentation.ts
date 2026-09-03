import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { RichTextInputHandle } from '../../components/RichTextInput';

interface UseReminderModalPresentationOptions {
	focusDelayMs: number;
	onClose: () => void;
	richTextInputRef: RefObject<RichTextInputHandle | null>;
}

export function useReminderModalPresentation({
	focusDelayMs,
	onClose,
	richTextInputRef,
}: UseReminderModalPresentationOptions) {
	const [currentView, setCurrentView] = useState<'main' | 'date' | 'project' | 'recurrence' | null>('main');
	const [isClosing, setIsClosing] = useState(false);
	const [showModal, setShowModal] = useState(true);
	const [isEntryAnimationComplete, setIsEntryAnimationComplete] = useState(false);
	const [allowAutoFocus, setAllowAutoFocus] = useState(focusDelayMs === 0);

	const hasClosedRef = useRef(false);

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
			richTextInputRef.current?.focus();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [allowAutoFocus, currentView, isClosing, richTextInputRef, showModal]);

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
		setCurrentView(targetView);
	}, []);

	const closePickerModal = useCallback(() => {
		setCurrentView('main');
		queueMicrotask(() => {
			richTextInputRef.current?.focus();
		});
	}, [richTextInputRef]);

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
