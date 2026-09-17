import React, { Suspense, lazy, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useKeyboardHeight } from '@/reminders/ui/hooks/useKeyboardHeight';
import { REMINDER_PICKER_COPY } from '@/reminders/ui/reminder-modal/pickerCopy';
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
const loadReminderPickerSheet = () => import('./ReminderPickerSheet')
	.then(module => ({ default: module.ReminderPickerSheet }));
const ReminderPickerSheet = lazy(loadReminderPickerSheet);
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
	const [pickerReady, setPickerReady] = useState(false);
	const handlePickerReady = useCallback(() => setPickerReady(true), []);
	const [preloadedPicker, setPreloadedPicker] = useState<typeof import('./ReminderPickerSheet').ReminderPickerSheet | null>(null);
	const PickerSheet = preloadedPicker ?? ReminderPickerSheet;
	useEffect(() => {
		// Fetch and evaluate pickers while the editor opens, before the first chip
		// tap. Render the resolved component directly to avoid Suspense's first
		// fallback delay even when the dynamic import is already cached.
		let active = true;
		void loadReminderPickerSheet().then(module => {
			if (active) setPreloadedPicker(() => module.default);
		}).catch(() => undefined);
		return () => { active = false; };
	}, []);
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
		onFocusEditor: () => editorScreenRef.current?.restoreFocus(),
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
	// Lazy picker code may arrive after the outgoing animation. Keep its stage
	// below the viewport until the content has mounted and has a real height.
	const isPickerLoading = activeScreen !== 'editor' && activeScreen !== 'delete' && !pickerReady;
	const handleReminderStageAnimationComplete = useCallback(() => {
		if (isPickerLoading) return;
		pickerTransitionClosedOffsetRef.current = '100%';
		pickerTransitionKeyboardInsetRef.current = 0;
		handleStageAnimationComplete();
	}, [handleStageAnimationComplete, isPickerLoading]);

	return (
		<PwaModalSheet
			isOpen={!isClosing}
			onClose={(reason) => {
				if (saving || isClosing || !canInteract) return false;
				if (modal.draft.deleteConfirm) transitionDeleteConfirmation(false);
				else if (activeScreen !== 'editor') returnToEditor();
				else {
					if (reason === 'swipe') {
						// A gesture may be accidental. Keep the persisted draft for reopening.
						editorScreenRef.current?.dismissKeyboard();
						dismissModal();
					} else onClose();
					return true;
				}
				return false;
			}}
			onCloseEnd={handleCloseEnd}
			variant="reminder"
			label={activeScreen === 'editor' ? modal.mode === 'edit' ? 'Edit reminder' : 'New reminder'
				: activeScreen === 'delete' ? 'Delete reminder'
				: REMINDER_PICKER_COPY[activeScreen === 'date' ? 'schedule' : activeScreen === 'recurrence' ? 'repeat' : 'project'].dialogLabel}
			role={activeScreen === 'delete' ? 'alertdialog' : 'dialog'}
			descriptionId={activeScreen === 'delete' ? `${confirmationId}-message` : undefined}
			sheetClassName={activeScreen === 'editor' || activeScreen === 'delete' ? 'is-editor-screen' : undefined}
			keyboardInset={renderedKeyboardInset}
			dismissible={!saving && !isClosing && canInteract}
		>
			<motion.div
				ref={reminderStageRef}
				className="pwa-reminder-sheet-stage"
				style={{ '--pwa-keyboard-inset': `${renderedKeyboardInset}px` } as React.CSSProperties}
				initial={false}
				animate={{ y: isStageClosing || isPickerLoading ? stageClosedOffset : '0%' }}
				transition={prefersReducedMotion || isPickerLoading
					? { duration: 0 }
					: isStageClosing
						// Focus restores synchronously on return, starting the native
						// keyboard. Shorten the wait before the editor appears,
						// but keep its entrance cadence consistent with other sheets.
						? { duration: isReturningToEditor ? 0.08 : 0.18, ease: [0.4, 0, 1, 1] }
						: { duration: 0.42, ease: [0.19, 0, 0, 1] }}
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
						<Suspense fallback={null}><PickerSheet
							isDark={colorScheme === 'dark'}
							draft={modal.draft}
							projectOptions={projectOptions}
							onPatch={patchDraft}
							onSelect={returnToEditor}
							onClose={() => returnToEditor()}
							onReady={handlePickerReady}
						/></Suspense>
					</div>
				)}
			</motion.div>
		</PwaModalSheet>
	);
}
