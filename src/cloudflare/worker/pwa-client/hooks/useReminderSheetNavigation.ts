import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ModalDraft, ModalMode, ModalPickerId } from '../types';

export type ReminderSheetScreen = 'editor' | ModalPickerId;

export interface ReminderSheetTransition {
	screen: ReminderSheetScreen;
	patch?: Partial<ModalDraft>;
}

export interface ReminderSheetNavigationState {
	activeScreen: ReminderSheetScreen;
	phase: 'open' | 'closing-for-transition' | 'awaiting-reopen' | 'closed';
	pendingTransition: ReminderSheetTransition | null;
}

export type ReminderSheetNavigationAction =
	| { type: 'request-transition'; transition: ReminderSheetTransition; isClosing: boolean }
	| { type: 'finish-transition' }
	| { type: 'finish-external-close' }
	| { type: 'reopen' }
	| { type: 'reset' };

export const INITIAL_REMINDER_SHEET_NAVIGATION_STATE: ReminderSheetNavigationState = {
	activeScreen: 'editor',
	phase: 'open',
	pendingTransition: null,
};

export function reduceReminderSheetNavigation(
	state: ReminderSheetNavigationState,
	action: ReminderSheetNavigationAction,
): ReminderSheetNavigationState {
	switch (action.type) {
		case 'request-transition':
			if (action.isClosing || state.phase !== 'open' || state.pendingTransition) return state;
			return { ...state, phase: 'closing-for-transition', pendingTransition: action.transition };
		case 'finish-transition':
			if (state.phase !== 'closing-for-transition' || !state.pendingTransition) return state;
			return {
				activeScreen: state.pendingTransition.screen,
				phase: 'awaiting-reopen',
				pendingTransition: null,
			};
		case 'finish-external-close':
			return { ...state, phase: 'closed', pendingTransition: null };
		case 'reopen':
			return state.phase === 'awaiting-reopen' ? { ...state, phase: 'open' } : state;
		case 'reset':
			return INITIAL_REMINDER_SHEET_NAVIGATION_STATE;
	}
}

export function getReminderSheetTransitionPatch(
	transition: ReminderSheetTransition,
): Partial<ModalDraft> {
	return transition.screen === 'editor'
		? { ...transition.patch, activePicker: null, deleteConfirm: false }
		: { activePicker: transition.screen, deleteConfirm: false };
}

export function useReminderSheetNavigation({
	mode,
	reminderId,
	isClosing,
	onBeforeOpenPicker,
	onPatchDraft,
	onClosed,
}: {
	mode: ModalMode;
	reminderId?: string;
	isClosing: boolean;
	onBeforeOpenPicker: () => void;
	onPatchDraft: (patch: Partial<ModalDraft>) => void;
	onClosed: () => void;
}) {
	const [navigation, setNavigation] = useState(INITIAL_REMINDER_SHEET_NAVIGATION_STATE);
	const navigationRef = useRef(navigation);
	const isClosingRef = useRef(isClosing);
	const reopenFrameRef = useRef<number | null>(null);
	isClosingRef.current = isClosing;

	const applyAction = useCallback((action: ReminderSheetNavigationAction) => {
		const current = navigationRef.current;
		const next = reduceReminderSheetNavigation(current, action);
		if (next === current) return false;
		navigationRef.current = next;
		setNavigation(next);
		return true;
	}, []);

	const cancelReopen = useCallback(() => {
		if (reopenFrameRef.current === null) return;
		window.cancelAnimationFrame(reopenFrameRef.current);
		reopenFrameRef.current = null;
	}, []);

	useEffect(() => () => cancelReopen(), [cancelReopen]);

	useEffect(() => {
		cancelReopen();
		applyAction({ type: 'reset' });
	}, [applyAction, cancelReopen, mode, reminderId]);

	const requestTransition = useCallback((transition: ReminderSheetTransition) => (
		applyAction({ type: 'request-transition', transition, isClosing })
	), [applyAction, isClosing]);

	const openPicker = useCallback((picker: ModalPickerId) => {
		if (!requestTransition({ screen: picker })) return;
		onBeforeOpenPicker();
	}, [onBeforeOpenPicker, requestTransition]);

	const returnToEditor = useCallback((patch: Partial<ModalDraft> = {}) => {
		if (isClosingRef.current) return;
		requestTransition({ screen: 'editor', patch });
	}, [requestTransition]);

	const handleCloseEnd = useCallback(() => {
		if (isClosingRef.current) {
			cancelReopen();
			applyAction({ type: 'finish-external-close' });
			onClosed();
			return;
		}

		const transition = navigationRef.current.pendingTransition;
		if (!transition) return;

		flushSync(() => {
			applyAction({ type: 'finish-transition' });
			onPatchDraft(getReminderSheetTransitionPatch(transition));
		});
		reopenFrameRef.current = window.requestAnimationFrame(() => {
			reopenFrameRef.current = null;
			if (isClosingRef.current) return;
			applyAction({ type: 'reopen' });
		});
	}, [applyAction, cancelReopen, onClosed, onPatchDraft]);

	return {
		activeScreen: navigation.activeScreen,
		sheetOpen: navigation.phase === 'open',
		openPicker,
		returnToEditor,
		handleCloseEnd,
	};
}
