import React, { Suspense, lazy, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useKeyboardHeight } from '@/reminders/ui/hooks/useKeyboardHeight';
import { useDialogFocus } from '../hooks/useDialogFocus';
import {
	getReminderSheetClosedOffset,
	useReminderSheetNavigation,
} from '../hooks/useReminderSheetNavigation';
import { discardReminderDraft, inspectReminderDraft, restoreReminderDraft, saveReminderDraft } from '../reminder-drafts';
import type { ModalDraft, ModalState } from '../types';
import {
	ReminderEditorScreen,
	type ReminderEditorScreenHandle,
} from './ReminderEditorScreen';
import { PwaModalSheet } from './PwaModalSheet';
import { PwaDeleteConfirmation } from './PwaDeleteConfirmation';
import { buildDeleteConfirmationMessage } from '@/reminders/ui/reminder-modal/deleteConfirmation';
import { useEditorSheetHeight } from '../hooks/useEditorSheetHeight';
import { DeferredNotice } from './DeferredNotice';
const ReminderPickerSheet = lazy(() => import('./ReminderPickerSheet')
	.then(module => ({ default: module.ReminderPickerSheet })));
const ReminderDraftRecoverySheet = lazy(() => import('./ReminderDraftRecoverySheet')
	.then(module => ({ default: module.ReminderDraftRecoverySheet })));

type ReminderSheetProps = {
	modal: ModalState;
	folderPath: string;
	projects: string[];
	colorScheme: 'dark' | 'light';
	saving: boolean;
	isClosing: boolean;
	onClose: () => void;
	onClosed: () => void;
	onSave: (modal: ModalState) => void;
	onDelete: (id: string, expectedRevision?: string, filePath?: string) => void;
};

export function ReminderSheet(props: ReminderSheetProps) {
	const [inspection, setInspection] = useState(() => inspectReminderDraft(props.modal, props.folderPath));
	if (inspection.recovery || inspection.unavailable) return <DeferredNotice>
		<ReminderDraftRecoverySheet inspection={inspection} initial={props.modal} folderPath={props.folderPath} isClosing={props.isClosing}
			onClose={props.onClose} onClosed={props.onClosed} onRetry={() => setInspection(inspectReminderDraft(props.modal, props.folderPath))} />
	</DeferredNotice>;
	return <ReminderEditorSheet {...props} />;
}

function ReminderEditorSheet({
	modal: initialModal,
	folderPath,
	projects,
	colorScheme,
	saving,
	isClosing,
	onClose: dismissModal,
	onClosed,
	onSave,
	onDelete,
}: ReminderSheetProps) {
	// Keep keystrokes local so the reminder list does not render behind the sheet.
	const [modal, setModal] = useState(() => restoreReminderDraft(initialModal, folderPath));
	const editorScreenRef = useRef<ReminderEditorScreenHandle | null>(null);
	const onClose = () => {
		editorScreenRef.current?.dismissKeyboard();
		discardReminderDraft(modal, folderPath);
		dismissModal();
	};
	useLayoutEffect(() => {
		// Also cover closes initiated outside the editor, such as deletion.
		// Start native keyboard dismissal before painting the sheet's exit.
		if (isClosing) editorScreenRef.current?.dismissKeyboard();
	}, [isClosing]);
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
		setModal((current) => {
			const next = { ...current, draft: { ...current.draft, ...patch } };
				saveReminderDraft(next, folderPath);
			return next;
		});
	}, [folderPath]);
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
		transitionDeleteConfirmation,
		returnToEditor,
		handleStageAnimationComplete,
		handleCloseEnd,
	} = useReminderSheetNavigation({
		mode: modal.mode,
		reminderId: modal.reminderId,
		isClosing,
		onBeforeOpenPicker: dismissEditorKeyboard,
		onFocusEditor: () => editorScreenRef.current?.focusTitle(),
		onPatchDraft: patchDraft,
		onClosed,
	});
	const deleteScreenRef = useRef<HTMLDivElement | null>(null);
	const confirmationId = useId();
	useEditorSheetHeight(deleteScreenRef, activeScreen === 'delete', true);
	const pickerTransitionKeyboardInset = isStageClosing
		? pickerTransitionKeyboardInsetRef.current
		: 0;
	const renderedKeyboardInset = activeScreen === 'editor'
		? pickerTransitionKeyboardInset || keyboardInset
		: 0;
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
			if (isClosing || !canInteract) return;
			if (modal.draft.deleteConfirm) transitionDeleteConfirmation(false);
			else if (activeScreen !== 'editor') returnToEditor();
			else onClose();
		},
	});

	return (
		<PwaModalSheet
			isOpen={!isClosing}
			onClose={() => {
				if (saving || isClosing || !canInteract) return;
				if (modal.draft.deleteConfirm) transitionDeleteConfirmation(false);
				else if (activeScreen !== 'editor') returnToEditor();
				else onClose();
			}}
			onCloseEnd={handleCloseEnd}
			variant="reminder"
			sheetClassName={activeScreen === 'editor' || activeScreen === 'delete' ? 'is-editor-screen' : undefined}
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
					keyboardInset={keyboardInset}
					editorFocusRequest={editorFocusRequest}
					dialogRef={setDialogRef}
					onPatchDraft={patchDraft}
					onOpenPicker={openPicker}
					onDeleteConfirmationChange={transitionDeleteConfirmation}
					onClose={onClose}
					onSave={onSave}
				/>
				{activeScreen === 'delete' && (
					<div ref={deleteScreenRef} className="pwa-reminder-sheet-screen modal-card pwa-reminder-editor is-active">
						<PwaDeleteConfirmation
							id={confirmationId}
							message={buildDeleteConfirmationMessage(modal.draft)}
							isLoading={saving}
							onClose={() => { if (!saving) returnToEditor(); }}
							onConfirm={() => {
								if (!saving && !isClosing && canInteract && modal.reminderId) {
									onDelete(modal.reminderId, modal.expectedRevision, modal.filePath);
								}
							}}
						/>
					</div>
				)}
				{activeScreen !== 'editor' && activeScreen !== 'delete' && (
					<div className="pwa-reminder-sheet-screen pwa-reminder-sheet-screen--picker is-active">
						<Suspense fallback={null}><ReminderPickerSheet
							isDark={colorScheme === 'dark'}
							draft={modal.draft}
							dialogRef={setDialogRef}
							projectOptions={projectOptions}
							onPatch={patchDraft}
							onSelect={returnToEditor}
							onClose={() => returnToEditor()}
						/></Suspense>
					</div>
				)}
			</motion.div>
		</PwaModalSheet>
	);
}
