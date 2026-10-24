import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useMemo,
} from 'react';
import { deriveReminderDraftContentMetadata } from '@/reminders/core/reminderDraft';
import { getProjectColor } from '@/reminders/ui/format/projectColors';
import { IconButton } from '@/ui/shared/IconButton';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import { usePreserveFieldFocus } from '@/ui/shared/usePreserveFieldFocus';
import type { RichTextInputHandle } from '@/reminders/ui/shared/RichTextInput';
import { ReminderEditorFields } from '@/reminders/ui/reminder-editor/ReminderEditorFields';
import { ReminderActionChips } from '@/reminders/ui/reminder-editor/ReminderActionChips';
import { useKeyboardDoneSave } from './useKeyboardDoneSave';
import { useEditorSheetHeight } from './useEditorSheetHeight';
import { useEditorFocus } from './useEditorFocus';
import { useEditorFieldActivation } from './useEditorFieldActivation';
import {
	applyReminderTextUpdate,
	deriveDraftPatchFromContent,
	formatModalDueSummary,
} from './editor-draft';
import type { ModalDraft, ModalPickerId, ModalState } from '../types';
import { DEFAULT_PROJECT } from '@/reminders/core/constants';
import { getReminderTitleCaret } from '@/reminders/ui/reminder-editor/reminderEditorEdits';
import { saveCursorPosition } from '@/reminders/ui/reminder-editor/cursorPosition';

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
	const latestContentRef = useRef(draft.content);
	latestContentRef.current = draft.content;
	const focusedContentRef = useRef(draft.content);
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
		dismissKeyboard: () => {
			focusedContentRef.current = latestContentRef.current;
			rememberFocus();
			dismissEditorKeyboard();
		},
		restoreFocus: () => {
			const content = latestContentRef.current;
			restoreFocus(content === focusedContentRef.current ? undefined : getReminderTitleCaret(content, projectOptions));
		},
	}), [dismissEditorKeyboard, projectOptions, rememberFocus, restoreFocus]);

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
			const wordsEnd = getReminderTitleCaret(patch.content, projectOptions);
			const caret = saveCursorPosition(richTextInputRef.current?.getElement() ?? null);
			richTextInputRef.current?.setCursorPosition(Math.min(caret ?? wordsEnd, wordsEnd), {
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
						type: 'submit', disabled: !canSubmit, busy: saving, dataAction: 'save-reminder', icon: 'arrow-up',
					}}
				/>
				<div className="reminder-modal-body">
					<ReminderEditorFields
						content={draft.content}
						onContentChange={(content) => onPatchDraft({ content })}
						description={draft.description}
						onDescriptionChange={(description) => onPatchDraft({ description })}
						projects={projectOptions}
						isDark={colorScheme === 'dark'}
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
					defaultProject={draft.defaultProject || DEFAULT_PROJECT}
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
