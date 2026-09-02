import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { RichTextInputHandle } from '../../components/RichTextInput';

interface UseReminderModalPresentationOptions {
	focusDelayMs: number;
	dueDate: string | null;
	project: string;
	onClose: () => void;
	richTextInputRef: RefObject<RichTextInputHandle | null>;
}

export function useReminderModalPresentation({
	focusDelayMs,
	dueDate,
	project,
	onClose,
	richTextInputRef,
}: UseReminderModalPresentationOptions) {
	const [currentView, setCurrentView] = useState<'main' | 'date' | 'project' | 'recurrence' | null>('main');
	const [isClosing, setIsClosing] = useState(false);
	const [showModal, setShowModal] = useState(true);
	const [isEntryAnimationComplete, setIsEntryAnimationComplete] = useState(false);
	const [allowAutoFocus, setAllowAutoFocus] = useState(focusDelayMs === 0);

	const hasMounted = useRef(false);
	const prevDueDateRef = useRef(dueDate);
	const prevProjectRef = useRef(project);
	const hasClosedRef = useRef(false);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			hasMounted.current = true;
		}, 50);
		return () => window.clearTimeout(timer);
	}, []);

	useEffect(() => {
		prevDueDateRef.current = dueDate;
		prevProjectRef.current = project;
	});

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
		if (currentView === 'main' && showModal && !isClosing) {
			richTextInputRef.current?.focus();
		}
	}, [currentView, isClosing, richTextInputRef, showModal]);

	return {
		currentView,
		isClosing,
		showModal,
		isEntryAnimationComplete,
		allowAutoFocus,
		hasMounted: hasMounted.current,
		dueDateChanged: hasMounted.current && prevDueDateRef.current !== dueDate,
		projectChanged: hasMounted.current && prevProjectRef.current !== project,
		handleClose,
		handleModalExitComplete,
		transitionToView,
		closePickerModal,
		handleEntryAnimationComplete,
	};
}
