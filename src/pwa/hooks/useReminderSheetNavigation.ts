import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ModalDraft, ModalMode, ModalPickerId } from '../types';

type ReminderSheetScreen = 'editor' | ModalPickerId;

export interface ReminderSheetTransition {
	screen: ReminderSheetScreen;
	patch?: Partial<ModalDraft>;
}

export interface ReminderSheetNavigationState {
	activeScreen: ReminderSheetScreen;
	phase: 'open' | 'closing-for-transition' | 'opening-after-transition' | 'closed';
	pendingTransition: ReminderSheetTransition | null;
}

export type ReminderSheetNavigationAction =
	| { type: 'request-transition'; transition: ReminderSheetTransition; isClosing: boolean }
	| { type: 'finish-transition' }
	| { type: 'finish-opening' }
	| { type: 'finish-external-close' }
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
				phase: 'opening-after-transition',
				pendingTransition: null,
			};
		case 'finish-opening':
			return state.phase === 'opening-after-transition' ? { ...state, phase: 'open' } : state;
		case 'finish-external-close':
			return { ...state, phase: 'closed', pendingTransition: null };
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

export function getImmediateEditorTransitionPatch(
	activePicker: ModalPickerId,
	patch: Partial<ModalDraft>,
): Partial<ModalDraft> {
	return { ...patch, activePicker, deleteConfirm: false };
}

export function getReminderSheetClosedOffset(stageHeight: number, keyboardInset: number): string {
	const closeDistance = Math.ceil(stageHeight + keyboardInset);
	return closeDistance > 0 ? `${closeDistance}px` : '100%';
}

export function useReminderSheetNavigation({
	mode,
	reminderId,
	isClosing,
	onBeforeOpenPicker,
	onFocusEditor,
	onPatchDraft,
	onClosed,
}: {
	mode: ModalMode;
	reminderId?: string;
	isClosing: boolean;
	onBeforeOpenPicker: () => void;
	onFocusEditor: () => void;
	onPatchDraft: (patch: Partial<ModalDraft>) => void;
	onClosed: () => void;
}) {
	const [navigation, setNavigation] = useState(INITIAL_REMINDER_SHEET_NAVIGATION_STATE);
	const [editorFocusRequest, setEditorFocusRequest] = useState(0);
	const navigationRef = useRef(navigation);
	const isClosingRef = useRef(isClosing);
	isClosingRef.current = isClosing;

	const applyAction = useCallback((action: ReminderSheetNavigationAction) => {
		const current = navigationRef.current;
		const next = reduceReminderSheetNavigation(current, action);
		if (next === current) return false;
		navigationRef.current = next;
		setNavigation(next);
		return true;
	}, []);

	useEffect(() => {
		applyAction({ type: 'reset' });
		setEditorFocusRequest(0);
	}, [applyAction, mode, reminderId]);

	const requestTransition = useCallback((transition: ReminderSheetTransition) => (
		applyAction({ type: 'request-transition', transition, isClosing })
	), [applyAction, isClosing]);

	const openPicker = useCallback((picker: ModalPickerId) => {
		if (!requestTransition({ screen: picker })) return;
		onBeforeOpenPicker();
	}, [onBeforeOpenPicker, requestTransition]);

	const returnToEditor = useCallback((patch: Partial<ModalDraft> = {}) => {
		const activeScreen = navigationRef.current.activeScreen;
		if (activeScreen === 'editor') return;

		let accepted = false;
		flushSync(() => {
			if (!applyAction({
				type: 'request-transition',
				transition: { screen: 'editor', patch },
				isClosing: isClosingRef.current,
			})) return;
			accepted = true;
			onPatchDraft(getImmediateEditorTransitionPatch(activeScreen, patch));
			setEditorFocusRequest((request) => request + 1);
		});
		// iOS requires focus inside the user gesture, after the editor is focusable.
		if (accepted) onFocusEditor();
	}, [applyAction, onFocusEditor, onPatchDraft]);

	const handleStageAnimationComplete = useCallback(() => {
		if (isClosingRef.current) return;

		const current = navigationRef.current;
		if (current.phase === 'opening-after-transition') {
			applyAction({ type: 'finish-opening' });
			return;
		}
		if (current.phase !== 'closing-for-transition' || !current.pendingTransition) return;

		const transition = current.pendingTransition;
		flushSync(() => {
			applyAction({ type: 'finish-transition' });
			onPatchDraft(getReminderSheetTransitionPatch(transition));
		});
	}, [applyAction, onPatchDraft]);

	const handleCloseEnd = useCallback(() => {
		if (!isClosingRef.current) return;
		applyAction({ type: 'finish-external-close' });
		onClosed();
	}, [applyAction, onClosed]);

	return {
		activeScreen: navigation.activeScreen,
		canInteract: navigation.phase === 'open',
		editorFocusRequest,
		isReturningToEditor: navigation.phase === 'closing-for-transition'
			&& navigation.pendingTransition?.screen === 'editor',
		isStageClosing: navigation.phase === 'closing-for-transition',
		openPicker,
		returnToEditor,
		handleStageAnimationComplete,
		handleCloseEnd,
	};
}
