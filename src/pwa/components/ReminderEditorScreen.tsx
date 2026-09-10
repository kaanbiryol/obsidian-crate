import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useMemo,
} from 'react';
import { deriveReminderDraftContentMetadata } from '@/reminders/core/reminderDraft';
import { getProjectColor } from '@/reminders/utils/projectColors';
import { IconButton } from '@/ui/shared/IconButton';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import type { RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ReminderEditorFields } from '@/reminders/ui/reminder-modal/ReminderEditorFields';
import { ReminderActionChips } from '@/reminders/ui/reminder-modal/ReminderActionChips';
import { useKeyboardDoneSave } from '../hooks/useKeyboardDoneSave';
import { useEditorSheetHeight } from '../hooks/useEditorSheetHeight';
import {
	applyReminderTextUpdate,
	deriveDraftPatchFromContent,
	formatModalDueSummary,
} from '../reminder-state';
import type { ModalDraft, ModalPickerId, ModalState } from '../types';

export interface ReminderEditorScreenHandle {
	dismissKeyboard(): void;
	focusTitle(): void;
}

export const ReminderEditorScreen = forwardRef<ReminderEditorScreenHandle, {
	modal: ModalState;
	colorScheme: 'dark' | 'light';
	projectOptions: string[];
	saving: boolean;
	isClosing: boolean;
	isActive: boolean;
	isReturningToEditor: boolean;
	canInteract: boolean;
	keyboardInset: number;
	editorFocusRequest: number;
	dialogRef: (element: HTMLElement | null) => void;
	onPatchDraft: (patch: Partial<ModalDraft>) => void;
	onOpenPicker: (picker: ModalPickerId) => void;
	onDeleteConfirmationChange: (open: boolean) => void;
	onClose: () => void;
	onSave: (modal: ModalState) => void;
}>(function ReminderEditorScreen({
	modal,
	colorScheme,
	projectOptions,
	saving,
	isClosing,
	isActive,
	isReturningToEditor,
	canInteract,
	keyboardInset,
	editorFocusRequest,
	dialogRef,
	onPatchDraft,
	onOpenPicker,
	onDeleteConfirmationChange,
	onClose,
	onSave,
}, ref) {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<HTMLDivElement | null>(null);
	useEditorSheetHeight(editorRef, isActive);
	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) return;
		let moved = false;
		const startTouch = () => { moved = false; };
		const moveTouch = () => { moved = true; };
		const keepEditorFocus = (event: Event) => {
			if (event.type === 'touchend' && moved) return;
			if (!(event.target instanceof Element)) return;
			const control = event.target.closest('button, input, textarea, select, a[href], label, [contenteditable="true"], [role="button"], [role="option"]');
			if (!control) event.preventDefault();
		};
		// Cancel the tap's focus transfer, not touchstart, so drags on empty
		// sheet space can still scroll. Actual fields and actions stay native.
		editor.addEventListener('touchstart', startTouch, { passive: true });
		editor.addEventListener('touchmove', moveTouch, { passive: true });
		editor.addEventListener('touchend', keepEditorFocus, { passive: false });
		editor.addEventListener('mousedown', keepEditorFocus);
		return () => {
			editor.removeEventListener('touchstart', startTouch);
			editor.removeEventListener('touchmove', moveTouch);
			editor.removeEventListener('touchend', keepEditorFocus);
			editor.removeEventListener('mousedown', keepEditorFocus);
		};
	}, []);

	const setEditorRef = useCallback((element: HTMLDivElement | null) => {
		editorRef.current = element;
		if (isActive) dialogRef(element);
	}, [dialogRef, isActive]);
	const richTextInputRef = useRef<RichTextInputHandle | null>(null);
	const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
	const draft = modal.draft;
	const contentMetadata = useMemo(
		() => deriveReminderDraftContentMetadata(draft.content, projectOptions, draft.defaultProject),
		[draft.content, draft.defaultProject, projectOptions],
	);
	const isEditing = modal.mode === 'edit';
	const title = isEditing ? 'Edit reminder' : 'New reminder';
	const editorInteractive = isActive || isReturningToEditor;
	const canSubmit = !draft.deleteConfirm
		&& !saving
		&& !isClosing
		&& Boolean(contentMetadata.cleanContent.trim());
	const performSave = useCallback(() => {
		if (!canSubmit) return;
		onSave(modal);
	}, [canSubmit, modal, onSave]);
	const {
		dismissEditorKeyboard,
		handleDescriptionFocus,
		handleEditorFieldBlur,
		handleTitleFocus,
	} = useKeyboardDoneSave({
		canSubmit,
		contentRef,
		descriptionRef,
		richTextInputRef,
		onSave: performSave,
	});
	const saveReminder = useCallback(() => {
		dismissEditorKeyboard();
		performSave();
	}, [dismissEditorKeyboard, performSave]);
	const closeReminder = useCallback(() => {
		dismissEditorKeyboard();
		onClose();
	}, [dismissEditorKeyboard, onClose]);

	useImperativeHandle(ref, () => ({
		dismissKeyboard: dismissEditorKeyboard,
		focusTitle: () => richTextInputRef.current?.focus(),
	}), [dismissEditorKeyboard]);

	useEffect(() => {
		if (!isActive || !canInteract) return;
		const patch = deriveDraftPatchFromContent(draft, projectOptions, contentMetadata);
		if (Object.keys(patch).length > 0) {
			onPatchDraft(patch);
		}
	}, [canInteract, contentMetadata, draft, isActive, onPatchDraft, projectOptions]);

	const togglePriority = useCallback(() => {
		const patch = applyReminderTextUpdate(draft, projectOptions, {
			priority: draft.priority === 1 ? 4 : 1,
		});
		if (typeof patch.content === 'string') {
			richTextInputRef.current?.setCursorPosition(patch.content.length, {
				scrollTop: richTextInputRef.current.getElement()?.scrollTop ?? 0,
			});
		}
		onPatchDraft({ ...patch, activePicker: null });
	}, [draft, onPatchDraft, projectOptions]);

	return (
		<div
			ref={setEditorRef}
			className={`pwa-reminder-sheet-screen pwa-reminder-sheet-screen--editor modal-card pwa-reminder-editor${isActive ? ' is-active' : ''}${isReturningToEditor ? ' is-focus-target' : ''}`}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			aria-busy={saving || isClosing}
			aria-hidden={!editorInteractive}
			inert={!editorInteractive}
			tabIndex={-1}
			onPointerDownCapture={(event) => {
				if (event.pointerType !== 'touch' || !(event.target instanceof Element)) return;
				const field = event.target.closest<HTMLElement>('textarea, [contenteditable="true"]');
				if (!field || field === document.activeElement) return;
				// iOS otherwise pans the document when switching fields. Focus before
				// its default action, without canceling the tap or changing selection.
				field.focus({ preventScroll: true });
			}}
		>
			<form
				className="modal-form"
				autoComplete="off"
				onSubmit={(event) => {
					event.preventDefault();
					saveReminder();
				}}
			>
				<ModalHeader
					title={title}
					titleLive="polite"
					closeLabel="Close reminder editor"
					onClose={closeReminder}
					closeDisabled={saving}
					preventFocusOnPress
					secondaryActions={isEditing ? (
						<IconButton
							icon="trash-2"
							label="Delete reminder"
							tone="danger"
							className="reminder-modal-header-icon reminder-header-delete"
							disabled={saving}
							preventFocusOnPress
							data-action="toggle-delete-confirm"
							onClick={() => {
								dismissEditorKeyboard();
								onDeleteConfirmationChange(true);
							}}
						/>
					) : undefined}
					action={{
						label: saving ? 'Saving…' : isEditing ? 'Save' : 'Add',
						ariaLabel: saving ? 'Saving reminder' : isEditing ? 'Save reminder' : 'Add reminder',
						type: 'submit', disabled: !canSubmit, busy: saving, dataAction: 'save-reminder',
					}}
				/>
				<div className="reminder-modal-body" style={{
					'--reminder-project-color': getProjectColor(draft.project || draft.defaultProject)[colorScheme].accent,
				} as React.CSSProperties}>
					<ReminderEditorFields
						content={draft.content}
						onContentChange={(content) => onPatchDraft({ content })}
						description={draft.description}
						onDescriptionChange={(description) => onPatchDraft({ description })}
						projects={projectOptions}
						richTextInputRef={richTextInputRef}
						textareaRef={contentRef}
						descriptionRef={descriptionRef}
						disabled={saving || !editorInteractive}
						allowAutoFocus={!saving && !isClosing}
						titleInputProps={{
							preserveSelection: true, externalChangeCursor: 'end', syncContentBeforePaint: true,
							autoComplete: 'off', autoCorrect: 'off', spellCheck: false,
							onFocus: handleTitleFocus, onBlur: handleEditorFieldBlur,
							focusRequestKey: editorFocusRequest,
							className: 'pwa-editor-title-input pwa-editor-title-rich-input',
						}}
						descriptionInputProps={{
							autoComplete: 'off', autoCorrect: 'off', spellCheck: false,
							onFocus: handleDescriptionFocus, onBlur: handleEditorFieldBlur,
							className: 'pwa-editor-description-input',
						}}
					/>
					<ReminderActionChips
						animateLabels
						dueDate={draft.dueDate || null}
						dueDateLabel={draft.dueDate ? formatModalDueSummary(draft) : undefined}
						project={draft.project}
						defaultProject={draft.defaultProject || 'Inbox'}
						priority={draft.priority}
						recurrence={draft.recurrence}
						disabled={saving}
						inert={!canInteract || isClosing}
						preventFocusOnPress
						onOpenDatePicker={() => onOpenPicker('date')}
						onOpenProjectPicker={() => onOpenPicker('project')}
						onOpenRecurrencePicker={() => onOpenPicker('recurrence')}
						onTogglePriority={togglePriority}
					/>
				</div>
			</form>

		</div>
	);
});
