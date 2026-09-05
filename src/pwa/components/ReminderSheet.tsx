import React, { useCallback, useMemo, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useKeyboardHeight } from '@/reminders/ui/hooks/useKeyboardHeight';
import { useDialogFocus } from '../hooks/useDialogFocus';
import {
	getReminderSheetClosedOffset,
	useReminderSheetNavigation,
} from '../hooks/useReminderSheetNavigation';
import type { ModalDraft, ModalState } from '../types';
import {
	ReminderEditorScreen,
	type ReminderEditorScreenHandle,
} from './ReminderEditorScreen';
import { PwaModalSheet } from './PwaModalSheet';
import { ReminderPickerSheet } from './ReminderPickerSheet';

export function ReminderSheet({
	modal,
	projects,
	colorScheme,
	saving,
	isClosing,
	onChange,
	onClose,
	onClosed,
	onSave,
	onDelete,
}: {
	modal: ModalState;
	projects: string[];
	colorScheme: 'dark' | 'light';
	saving: boolean;
	isClosing: boolean;
	onChange: React.Dispatch<React.SetStateAction<ModalState | null>>;
	onClose: () => void;
	onClosed: () => void;
	onSave: (modal: ModalState) => void;
	onDelete: (id: string) => void;
}) {
	const editorScreenRef = useRef<ReminderEditorScreenHandle | null>(null);
	const pickerTransitionClosedOffsetRef = useRef('100%');
	const pickerTransitionKeyboardInsetRef = useRef(0);
	const reminderStageRef = useRef<HTMLDivElement | null>(null);
	const keyboardInset = useKeyboardHeight();
	const prefersReducedMotion = useReducedMotion();
	const projectOptions = useMemo(
		() => ['Inbox', ...projects.filter((project) => project !== 'Inbox')],
		[projects],
	);
	const patchDraft = useCallback((patch: Partial<ModalDraft>) => {
		onChange((current) => current ? ({ ...current, draft: { ...current.draft, ...patch } }) : current);
	}, [onChange]);
	const dismissEditorKeyboard = useCallback(() => {
		pickerTransitionClosedOffsetRef.current = getReminderSheetClosedOffset(
			reminderStageRef.current?.getBoundingClientRect().height ?? 0,
			keyboardInset,
		);
		pickerTransitionKeyboardInsetRef.current = keyboardInset;
		editorScreenRef.current?.dismissKeyboard();
	}, [keyboardInset]);
	const {
		activeScreen,
		canInteract,
		editorFocusRequest,
		isReturningToEditor,
		isStageClosing,
		openPicker,
		returnToEditor,
		handleStageAnimationComplete,
		handleCloseEnd,
	} = useReminderSheetNavigation({
		mode: modal.mode,
		reminderId: modal.reminderId,
		isClosing,
		onBeforeOpenPicker: dismissEditorKeyboard,
		onPatchDraft: patchDraft,
		onClosed,
	});
	const pickerTransitionKeyboardInset = isStageClosing
		? pickerTransitionKeyboardInsetRef.current
		: 0;
	const renderedKeyboardInset = pickerTransitionKeyboardInset || keyboardInset;
	const stageClosedOffset = isStageClosing
		? pickerTransitionClosedOffsetRef.current
		: '100%';
	const handleReminderStageAnimationComplete = useCallback(() => {
		pickerTransitionClosedOffsetRef.current = '100%';
		pickerTransitionKeyboardInsetRef.current = 0;
		handleStageAnimationComplete();
	}, [handleStageAnimationComplete]);
	const { handleDialogKeyDown, setDialogRef } = useDialogFocus({
		activeKey: activeScreen,
		autoFocus: false,
		escapeDisabled: saving,
		onEscape: () => {
			if (activeScreen !== 'editor') returnToEditor();
			else onClose();
		},
	});

	return (
		<PwaModalSheet
			isOpen={!isClosing}
			onClose={() => {
				if (saving || isClosing || !canInteract) return;
				if (activeScreen !== 'editor') returnToEditor();
				else onClose();
			}}
			onCloseEnd={handleCloseEnd}
			variant="reminder"
			sheetClassName={activeScreen === 'editor' ? 'is-editor-screen' : undefined}
			keyboardInset={renderedKeyboardInset}
			closeOnBackdrop={!saving && !isClosing && canInteract}
			onKeyDown={handleDialogKeyDown}
		>
			<motion.div
				ref={reminderStageRef}
				className="pwa-reminder-sheet-stage"
				initial={false}
				animate={{ y: isStageClosing ? stageClosedOffset : '0%' }}
				transition={prefersReducedMotion
					? { duration: 0 }
					: isStageClosing
						? { duration: 0.26, ease: [0.4, 0, 1, 1] }
						: { duration: 0.36, ease: [0.32, 0.72, 0, 1] }}
				onAnimationComplete={handleReminderStageAnimationComplete}
			>
				<ReminderEditorScreen
					colorScheme={colorScheme}
					ref={editorScreenRef}
					modal={modal}
					projectOptions={projectOptions}
					saving={saving}
					isClosing={isClosing}
					isActive={activeScreen === 'editor'}
					isReturningToEditor={isReturningToEditor}
					canInteract={canInteract}
					editorFocusRequest={editorFocusRequest}
					dialogRef={setDialogRef}
					onPatchDraft={patchDraft}
					onOpenPicker={openPicker}
					onClose={onClose}
					onSave={onSave}
					onDelete={onDelete}
				/>
				{activeScreen !== 'editor' && (
					<div className="pwa-reminder-sheet-screen pwa-reminder-sheet-screen--picker is-active">
						<ReminderPickerSheet
							isDark={colorScheme === 'dark'}
							draft={modal.draft}
							dialogRef={setDialogRef}
							projectOptions={projectOptions}
							onPatch={patchDraft}
							onSelect={returnToEditor}
							onClose={() => returnToEditor()}
						/>
					</div>
				)}
			</motion.div>
		</PwaModalSheet>
	);
}
