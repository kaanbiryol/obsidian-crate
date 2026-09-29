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
import { usePreserveFieldFocus } from '@/ui/shared/usePreserveFieldFocus';
import type { RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ReminderEditorFields } from '@/reminders/ui/reminder-modal/ReminderEditorFields';
import { ReminderActionChips } from '@/reminders/ui/reminder-modal/ReminderActionChips';
import { useKeyboardDoneSave } from '../hooks/useKeyboardDoneSave';
import { useEditorSheetHeight } from '../hooks/useEditorSheetHeight';
import { useEditorFocus } from '../hooks/useEditorFocus';
import { useEditorFieldActivation } from '../hooks/useEditorFieldActivation';
import {
	applyReminderTextUpdate,
	deriveDraftPatchFromContent,
	formatModalDueSummary,
} from '../reminder-state';
import type { ModalDraft, ModalPickerId, ModalState } from '../types';

export interface ReminderEditorScreenHandle {
	dismissKeyboard(): void;
	restoreFocus(): void;
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
	onPatchDraft: (patch: Partial<ModalDraft>) => void;
	onOpenPicker: (picker: ModalPickerId) => void;
	onDeleteConfirmationChange: (open: boolean) => void;
	onClose: () => void;
	onSave: (modal: ModalState) => Promise<boolean>;
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
	onPatchDraft,
	onOpenPicker,
	onDeleteConfirmationChange,
	onClose,
	onSave,
}, ref) {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const editorRef = useRef<HTMLDivElement | null>(null);
	const fieldActivation = useEditorFieldActivation();
	useEditorSheetHeight(editorRef, isActive);
	usePreserveFieldFocus(editorRef);

	const richTextInputRef = useRef<RichTextInputHandle | null>(null);
	const descriptionRef = useRef<HTMLDivElement | null>(null);
	const descriptionInputRef = useRef<RichTextInputHandle | null>(null);
	const { rememberFocus, restoreFocus } = useEditorFocus({
		titleRef: contentRef, descriptionRef, editorRef, active: isActive, keyboardInset,
	});
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
	const submissionStarted = useRef(false);
	const performSave = useCallback(() => {
		// Keyboard dismissal can leave a callback holding earlier props. Keep
		// one accepted command for this editor until the sheet unmounts.
		if (!canSubmit || submissionStarted.current) return;
		submissionStarted.current = true;
		const currentDraft = {
			...modal.draft,
			content: richTextInputRef.current?.getValue() ?? modal.draft.content,
			description: descriptionInputRef.current?.getValue() ?? modal.draft.description,
		};
		// Preserve settled relative dates; only reconcile text not yet in React state.
		if (currentDraft.content !== modal.draft.content) {
			Object.assign(currentDraft, deriveDraftPatchFromContent(currentDraft, projectOptions));
		}
		void onSave({ ...modal, draft: currentDraft }).then(accepted => {
			if (!accepted) submissionStarted.current = false;
		});
	}, [canSubmit, modal, onSave, projectOptions]);
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
		dismissKeyboard: () => { rememberFocus(); dismissEditorKeyboard(); },
		restoreFocus,
	}), [dismissEditorKeyboard, rememberFocus, restoreFocus]);

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
			ref={editorRef}
			className={`pwa-reminder-sheet-screen pwa-reminder-sheet-screen--editor modal-card pwa-reminder-editor${isActive ? ' is-active' : ''}${isReturningToEditor ? ' is-focus-target' : ''}`}
			aria-busy={saving || isClosing}
			aria-hidden={!editorInteractive}
			inert={!editorInteractive}
			tabIndex={-1}
			{...fieldActivation}
		>
			<form
				className="modal-form"
				style={{
					'--reminder-project-color': getProjectColor(draft.project || draft.defaultProject)[colorScheme].accent,
				} as React.CSSProperties}
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
								onDeleteConfirmationChange(true);
							}}
						/>
					) : undefined}
					action={{
						label: isEditing ? 'Save' : 'Add',
						ariaLabel: isEditing ? 'Save reminder' : 'Add reminder',
						type: 'submit', disabled: !canSubmit, busy: saving, dataAction: 'save-reminder',
					}}
				/>
				<div className="reminder-modal-body" data-base-ui-swipe-ignore="">
					<ReminderEditorFields
						content={draft.content}
						onContentChange={(content) => onPatchDraft({ content })}
						description={draft.description}
						onDescriptionChange={(description) => onPatchDraft({ description })}
						projects={projectOptions}
						richTextInputRef={richTextInputRef}
						textareaRef={contentRef}
						descriptionRef={descriptionRef}
						descriptionInputRef={descriptionInputRef}
						disabled={saving || !editorInteractive}
						allowAutoFocus={!saving && !isClosing}
						titleInputProps={{
							preserveSelection: true, externalChangeCursor: 'preserve', syncContentBeforePaint: true,
							autoComplete: 'off', autoCorrect: 'off', spellCheck: false,
							onFocus: handleTitleFocus, onBlur: handleEditorFieldBlur,
							className: 'pwa-editor-title-input pwa-editor-title-rich-input',
						}}
						descriptionInputProps={{
							autoComplete: 'off', autoCorrect: 'off', spellCheck: false,
							onFocus: handleDescriptionFocus, onBlur: handleEditorFieldBlur,
							className: 'pwa-editor-description-input',
						}}
					/>
				</div>
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
			</form>

		</div>
	);
});
