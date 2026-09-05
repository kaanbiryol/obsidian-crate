import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
} from 'react';
import { getProjectColor } from '@/reminders/utils/projectColors';
import { IconButton } from '@/ui/shared/IconButton';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import type { RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ReminderEditorFields } from '@/reminders/ui/reminder-modal/ReminderEditorFields';
import { ReminderActionChips } from '@/reminders/ui/reminder-modal/ReminderActionChips';
import { useKeyboardDoneSave } from '../hooks/useKeyboardDoneSave';
import {
	applyReminderTextUpdate,
	deriveDraftPatchFromContent,
	formatModalDueSummary,
	hasReminderDraftTitle,
} from '../reminder-state';
import type { ModalDraft, ModalPickerId, ModalState } from '../types';

export interface ReminderEditorScreenHandle {
	dismissKeyboard(): void;
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
	editorFocusRequest: number;
	dialogRef: (element: HTMLElement | null) => void;
	onPatchDraft: (patch: Partial<ModalDraft>) => void;
	onOpenPicker: (picker: ModalPickerId) => void;
	onClose: () => void;
	onSave: (modal: ModalState) => void;
	onDelete: (id: string) => void;
}>(function ReminderEditorScreen({
	modal,
	colorScheme,
	projectOptions,
	saving,
	isClosing,
	isActive,
	isReturningToEditor,
	canInteract,
	editorFocusRequest,
	dialogRef,
	onPatchDraft,
	onOpenPicker,
	onClose,
	onSave,
	onDelete,
}, ref) {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const richTextInputRef = useRef<RichTextInputHandle | null>(null);
	const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
	const draft = modal.draft;
	const isEditing = modal.mode === 'edit';
	const title = isEditing ? 'Edit reminder' : 'New reminder';
	const editorInteractive = isActive || isReturningToEditor;
	const canSubmit = !saving
		&& !isClosing
		&& hasReminderDraftTitle(draft.content, projectOptions, draft.defaultProject);
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
	}), [dismissEditorKeyboard]);

	useEffect(() => {
		if (!isActive || !canInteract) return;
		const patch = deriveDraftPatchFromContent(draft, projectOptions);
		if (Object.keys(patch).length > 0) {
			onPatchDraft(patch);
		}
	}, [canInteract, draft, isActive, onPatchDraft, projectOptions]);

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
			ref={isActive ? dialogRef : undefined}
			className={`pwa-reminder-sheet-screen pwa-reminder-sheet-screen--editor modal-card pwa-reminder-editor${isActive ? ' is-active' : ''}${isReturningToEditor ? ' is-focus-target' : ''}`}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			aria-busy={saving || isClosing}
			aria-hidden={!editorInteractive}
			inert={!editorInteractive}
			tabIndex={-1}
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
					title={draft.deleteConfirm ? 'Delete reminder?' : title}
					titleLive="polite"
					closeLabel="Close reminder editor"
					onClose={closeReminder}
					closeDisabled={saving}
					preventFocusOnPress
					secondaryActions={isEditing ? (
						<IconButton
							icon={draft.deleteConfirm ? 'x' : 'trash-2'}
							label={draft.deleteConfirm ? 'Keep reminder' : 'Delete reminder'}
							tone={draft.deleteConfirm ? 'neutral' : 'danger'}
							className="reminder-modal-header-icon reminder-header-delete"
							disabled={saving}
							preventFocusOnPress
							data-action="toggle-delete-confirm"
							onClick={() => onPatchDraft({ deleteConfirm: !draft.deleteConfirm, activePicker: null })}
						/>
					) : undefined}
					action={isEditing && draft.deleteConfirm ? {
						label: 'Delete', ariaLabel: 'Delete reminder', tone: 'danger',
						disabled: saving, dataAction: 'delete-reminder',
						onClick: () => { if (modal.reminderId) onDelete(modal.reminderId); },
					} : {
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
							maxLength: 4096, autoComplete: 'off', autoCorrect: 'off', spellCheck: false,
							onFocus: handleDescriptionFocus, onBlur: handleEditorFieldBlur,
							className: 'pwa-editor-description-input',
						}}
					/>
					<ReminderActionChips
						dueDate={draft.dueDate || null}
						dueDateLabel={draft.dueDate ? formatModalDueSummary(draft) : undefined}
						project={draft.project}
						defaultProject={draft.defaultProject || 'Inbox'}
						priority={draft.priority}
						recurrence={draft.recurrence}
						disabled={saving || !canInteract}
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
