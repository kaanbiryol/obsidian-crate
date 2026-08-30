import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
} from 'react';
import { Button } from '@heroui/react';
import { Calendar, Flag, Hash, Repeat, Trash2, X } from 'lucide-react';
import { RichTextInput, type RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ProjectAutocompleteDropdown } from '@/reminders/ui/reminder-modal/ProjectAutocompleteDropdown';
import { useProjectAutocomplete } from '@/reminders/ui/reminder-modal/useProjectAutocomplete';
import { formatRecurrence } from '@/reminders/utils/rruleConverter';
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
	const editorCardRef = useRef<HTMLDivElement | null>(null);
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

	const autocomplete = useProjectAutocomplete({
		content: draft.content,
		projects: projectOptions,
		onContentChange: (content) => onPatchDraft({ content }),
		richTextInputRef,
	});

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
				<div className="pwa-editor-header">
					<div className="pwa-editor-header__side">
						{isEditing ? (
							<Button
								isIconOnly
								className={`pwa-editor-icon-button ${draft.deleteConfirm ? 'pwa-editor-icon-button--muted' : 'pwa-editor-icon-button--danger'}`}
								type="button"
								data-action="toggle-delete-confirm"
								aria-label={draft.deleteConfirm ? 'Keep reminder' : 'Delete reminder'}
								isDisabled={saving}
								preventFocusOnPress
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => onPatchDraft({
									deleteConfirm: !draft.deleteConfirm,
									activePicker: null,
								})}
							>
								{draft.deleteConfirm ? <X size={20} /> : <Trash2 size={20} />}
							</Button>
						) : (
							<Button
								isIconOnly
								className="pwa-editor-icon-button pwa-editor-icon-button--muted"
								type="button"
								aria-label="Close modal"
								isDisabled={saving}
								preventFocusOnPress
								onPointerDown={(event) => event.preventDefault()}
								onClick={closeReminder}
							>
								<X size={20} />
							</Button>
						)}
					</div>
					<h2 className="pwa-editor-title" aria-live="polite">
						{draft.deleteConfirm ? 'Delete reminder?' : title}
					</h2>
					<div className="pwa-editor-header__side pwa-editor-header__side--right">
						{isEditing && draft.deleteConfirm ? (
							<Button
								className="pwa-editor-submit-button pwa-editor-submit-button--danger"
								type="button"
								data-action="delete-reminder"
								aria-label="Delete reminder"
								isDisabled={saving}
								preventFocusOnPress
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => modal.reminderId && onDelete(modal.reminderId)}
							>
								Delete
							</Button>
						) : (
							<Button
								className={`pwa-editor-submit-button${saving ? ' is-saving' : ''}`}
								type="submit"
								data-action="save-reminder"
								aria-label={saving ? 'Saving reminder' : isEditing ? 'Save reminder' : 'Add reminder'}
								aria-busy={saving}
								isDisabled={!canSubmit}
								preventFocusOnPress
								onPointerDown={(event) => event.preventDefault()}
							>
								{saving ? 'Saving…' : isEditing ? 'Save' : 'Add'}
							</Button>
						)}
					</div>
				</div>

				<div ref={editorCardRef} className="pwa-editor-card">
					<RichTextInput
						ref={richTextInputRef}
						value={draft.content}
						onChange={(content) => onPatchDraft({ content })}
						placeholder="Reminder title"
						ariaLabel="Reminder title"
						readOnly={saving || !editorInteractive}
						inputRef={contentRef}
						preserveSelection
						externalChangeCursor="end"
						syncContentBeforePaint
						autoFocus={!saving && !isClosing}
						autoComplete="off"
						autoCorrect="off"
						spellCheck={false}
						onFocus={handleTitleFocus}
						onBlur={handleEditorFieldBlur}
						focusRequestKey={editorFocusRequest}
						knownProjects={projectOptions}
						onAutocompleteQuery={autocomplete.updateAutocomplete}
						onAutocompleteKeyDown={autocomplete.handleKeyDown}
						className="pwa-editor-title-input pwa-editor-title-rich-input ios-scroll"
					/>
					{!saving && autocomplete.isOpen && (
						<ProjectAutocompleteDropdown
							filteredProjects={autocomplete.filteredProjects}
							highlightedIndex={autocomplete.highlightedIndex}
							anchorRect={autocomplete.rect}
							containerRef={editorCardRef}
							onSelect={autocomplete.selectProject}
						/>
					)}
					<div className="pwa-editor-divider" />
					<textarea
						ref={descriptionRef}
						className="pwa-editor-description-input ios-scroll"
						rows={2}
						maxLength={4096}
						placeholder="Description"
						aria-label="Reminder description"
						autoComplete="off"
						autoCorrect="off"
						spellCheck={false}
						value={draft.description}
						disabled={saving || !editorInteractive}
						onFocus={handleDescriptionFocus}
						onBlur={handleEditorFieldBlur}
						onChange={(event) => onPatchDraft({ description: event.currentTarget.value })}
					/>
				</div>

				<div className="pwa-editor-actions">
					<div className="pwa-editor-chip-row">
						<Button
							className={`pwa-editor-chip${draft.dueDate ? ' is-active' : ''}`}
							type="button"
							data-action="toggle-picker"
							data-picker="date"
							isDisabled={saving || !canInteract}
							onPointerDown={(event) => event.preventDefault()}
							onClick={() => onOpenPicker('date')}
						>
							<Calendar size={16} />
							<span>{draft.dueDate ? formatModalDueSummary(draft) : 'Date'}</span>
						</Button>
						<Button
							className="pwa-editor-chip"
							type="button"
							data-action="toggle-picker"
							data-picker="project"
							isDisabled={saving || !canInteract}
							onPointerDown={(event) => event.preventDefault()}
							onClick={() => onOpenPicker('project')}
						>
							<Hash size={16} />
							<span>{draft.project || 'Inbox'}</span>
						</Button>
						<Button
							isIconOnly
							className={`pwa-editor-chip pwa-editor-chip--icon${draft.priority === 1 ? ' is-important' : ''}`}
							type="button"
							data-action="toggle-priority"
							aria-label={draft.priority === 1 ? 'Remove priority' : 'Set priority'}
							isDisabled={saving}
							preventFocusOnPress
							onClick={togglePriority}
						>
							<Flag size={16} fill={draft.priority === 1 ? 'currentColor' : 'none'} />
							<span className="pwa-editor-chip__mobile-label">Priority</span>
						</Button>
						<Button
							isIconOnly
							className={`pwa-editor-chip pwa-editor-chip--icon${draft.recurrence ? ' is-active' : ''}`}
							type="button"
							data-action="toggle-picker"
							data-picker="recurrence"
							isDisabled={saving || !canInteract}
							aria-label={draft.recurrence ? formatRecurrence(draft.recurrence) : 'Recurrence'}
							onPointerDown={(event) => event.preventDefault()}
							onClick={() => onOpenPicker('recurrence')}
						>
							<Repeat size={16} />
							<span className="pwa-editor-chip__mobile-label">Repeat</span>
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
});
