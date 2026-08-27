import React, { useCallback, useEffect, useRef } from 'react';
import { Button } from '@heroui/react';
import { useVirtualKeyboard } from 'react-modal-sheet';
import {
	ArrowUp,
	Calendar,
	Check,
	Flag,
	Hash,
	Repeat,
	Trash2,
	X,
} from 'lucide-react';
import { RichTextInput, type RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ProjectAutocompleteDropdown } from '@/reminders/ui/reminder-modal/ProjectAutocompleteDropdown';
import { useProjectAutocomplete } from '@/reminders/ui/reminder-modal/useProjectAutocomplete';
import { formatRecurrence } from '@/reminders/utils/rruleConverter';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useReminderSheetNavigation } from '../hooks/useReminderSheetNavigation';
import {
	applyReminderTextUpdate,
	deriveDraftPatchFromContent,
	formatModalDueSummary,
} from '../reminder-state';
import type { ModalDraft, ModalState } from '../types';
import { PwaModalSheet } from './PwaModalSheet';
import { ReminderPickerSheet } from './ReminderPickerSheet';

const MIN_RELIABLE_KEYBOARD_HEIGHT = 120;

export function ReminderSheet({
	modal,
	projects,
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
	saving: boolean;
	isClosing: boolean;
	onChange: React.Dispatch<React.SetStateAction<ModalState | null>>;
	onClose: () => void;
	onClosed: () => void;
	onSave: (modal: ModalState) => void;
	onDelete: (id: string) => void;
}) {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const richTextInputRef = useRef<RichTextInputHandle | null>(null);
	const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
	const editorCardRef = useRef<HTMLDivElement | null>(null);
	const closedViewportHeightRef = useRef(typeof window === 'undefined'
		? 0
		: Math.max(window.innerHeight, window.visualViewport?.height ?? 0));
	const { isKeyboardOpen, keyboardHeight } = useVirtualKeyboard({ isEnabled: true, debounceDelay: 60 });
	const fallbackKeyboardInset = Math.round(Math.min(360, Math.max(260, closedViewportHeightRef.current * 0.36)));
	const keyboardInset = isKeyboardOpen
		? (keyboardHeight >= MIN_RELIABLE_KEYBOARD_HEIGHT ? keyboardHeight : fallbackKeyboardInset)
		: 0;
	const draft = modal.draft;
	const projectOptions = ['Inbox', ...projects.filter((project) => project !== 'Inbox')];
	const isEditing = modal.mode === 'edit';
	const title = isEditing ? 'Edit Reminder' : 'New Reminder';
	const canSubmit = !saving && !isClosing && Boolean(draft.content.trim());
	const dismissEditorKeyboard = useCallback(() => {
		richTextInputRef.current?.getElement()?.blur();
		descriptionRef.current?.blur();
	}, []);
	const patchDraft = useCallback((patch: Partial<ModalDraft>) => {
		onChange((current) => current ? ({ ...current, draft: { ...current.draft, ...patch } }) : current);
	}, [onChange]);
	const {
		activeScreen,
		sheetOpen,
		openPicker,
		returnToEditor,
		handleCloseEnd,
	} = useReminderSheetNavigation({
		mode: modal.mode,
		reminderId: modal.reminderId,
		isClosing,
		onBeforeOpenPicker: dismissEditorKeyboard,
		onPatchDraft: patchDraft,
		onClosed,
	});

	const autocomplete = useProjectAutocomplete({
		content: draft.content,
		projects: projectOptions,
		onContentChange: (content) => patchDraft({ content }),
		richTextInputRef,
	});

	useEffect(() => {
		if (activeScreen !== 'editor' || !sheetOpen) return;
		const patch = deriveDraftPatchFromContent(draft, projectOptions);
		if (Object.keys(patch).length > 0) {
			patchDraft(patch);
		}
	}, [activeScreen, draft.content, projectOptions.join('\u0000'), sheetOpen]);

	const draftFromForm = (form: HTMLFormElement): ModalDraft => {
		const readField = (field: string) => {
			const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-draft-field="${field}"]`);
			return input?.value ?? '';
		};

		return {
			...draft,
			content: draft.content,
			description: readField('description') || draft.description,
			project: readField('project') || draft.project,
			dueDate: readField('dueDate') || draft.dueDate,
			dueTime: readField('dueTime') || draft.dueTime,
		};
	};

	const togglePriority = () => {
		const patch = applyReminderTextUpdate(draft, projectOptions, {
			priority: draft.priority === 1 ? 4 : 1,
		});
		if (typeof patch.content === 'string') {
			richTextInputRef.current?.setCursorPosition(patch.content.length, {
				scrollTop: richTextInputRef.current.getElement()?.scrollTop ?? 0,
			});
		}
		patchDraft({ ...patch, activePicker: null });
	};

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
				key={activeScreen}
				isOpen={sheetOpen && !isClosing}
				onClose={() => {
					if (saving || isClosing || !sheetOpen) return;
					if (activeScreen !== 'editor') returnToEditor();
					else onClose();
				}}
				onCloseEnd={handleCloseEnd}
				variant="reminder"
				keyboardInset={keyboardInset}
				closeOnBackdrop={!saving && !isClosing && sheetOpen}
				onKeyDown={handleDialogKeyDown}
			>
				<div className="pwa-reminder-sheet-stage">
					{activeScreen === 'editor' ? (
						<div
							ref={setDialogRef}
							className="modal-card pwa-reminder-editor"
							role="dialog"
							aria-modal="true"
							aria-label={title}
							aria-busy={saving || isClosing}
							tabIndex={-1}
						>
							<form className="modal-form" onSubmit={(event) => {
							event.preventDefault();
							if (saving) return;
							onSave({ ...modal, draft: draftFromForm(event.currentTarget) });
						}}>
						<div className="pwa-editor-header">
							<div className="pwa-editor-header__side">
								{isEditing ? (
									<Button
										isIconOnly
										className={`pwa-editor-icon-button pwa-editor-icon-button--danger${draft.deleteConfirm ? ' is-active' : ''}`}
										type="button"
										data-action="toggle-delete-confirm"
										aria-label="Delete reminder"
										isDisabled={saving}
										onClick={() => patchDraft({ deleteConfirm: !draft.deleteConfirm, activePicker: null })}
									>
										<Trash2 size={20} />
									</Button>
								) : (
									<Button
										isIconOnly
										className="pwa-editor-icon-button pwa-editor-icon-button--muted"
										type="button"
										aria-label="Close modal"
										isDisabled={saving}
										onClick={onClose}
									>
										<X size={20} />
									</Button>
								)}
							</div>
							<h2 className="pwa-editor-title">{title}</h2>
							<div className="pwa-editor-header__side pwa-editor-header__side--right">
								<Button
									isIconOnly
									className="pwa-editor-icon-button pwa-editor-icon-button--save"
									type="submit"
									data-action="save-reminder"
									aria-label={isEditing ? 'Save reminder' : 'Add reminder'}
									isDisabled={!canSubmit}
									isLoading={saving}
								>
									{isEditing ? <Check size={22} /> : <ArrowUp size={22} />}
								</Button>
							</div>
						</div>

						<div ref={editorCardRef} className="pwa-editor-card">
							<RichTextInput
								ref={richTextInputRef}
								value={draft.content}
								onChange={(content) => patchDraft({ content })}
								placeholder={isEditing ? 'Edit your reminder...' : 'What do you need to remember?'}
								ariaLabel="Reminder title"
								readOnly={saving}
								inputRef={contentRef}
								preserveSelection
								externalChangeCursor="end"
								syncContentBeforePaint
								autoFocus={sheetOpen && !saving && !isClosing}
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
								data-draft-field="description"
								className="pwa-editor-description-input ios-scroll"
								rows={3}
								maxLength={4096}
								placeholder="Add description..."
								aria-label="Reminder description"
								value={draft.description}
								disabled={saving}
								onChange={(event) => patchDraft({ description: event.currentTarget.value })}
							/>
						</div>

						<div className="pwa-editor-actions">
							<div className="pwa-editor-chip-row">
							<Button
								className={`pwa-editor-chip${draft.dueDate ? ' is-active' : ''}`}
								type="button"
								data-action="toggle-picker"
								data-picker="date"
								isDisabled={saving || !sheetOpen}
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => openPicker('date')}
							>
								<Calendar size={16} />
								<span>{draft.dueDate ? formatModalDueSummary(draft) : 'Date'}</span>
							</Button>
							<Button
								className="pwa-editor-chip"
								type="button"
								data-action="toggle-picker"
								data-picker="project"
								isDisabled={saving || !sheetOpen}
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => openPicker('project')}
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
								isDisabled={saving || !sheetOpen}
								aria-label={draft.recurrence ? formatRecurrence(draft.recurrence) : 'Recurrence'}
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => openPicker('recurrence')}
							>
								<Repeat size={16} />
								<span className="pwa-editor-chip__mobile-label">Repeat</span>
							</Button>
							</div>

							{isEditing && draft.deleteConfirm && (
								<div className="delete-confirm">
									<div>
										<strong>Delete this reminder?</strong>
										<p>This removes it from the original markdown file and cancels its scheduled notification.</p>
									</div>
									<div className="delete-confirm__actions">
										<Button className="secondary-button" type="button" isDisabled={saving} onClick={() => patchDraft({ deleteConfirm: false })}>Keep it</Button>
										<Button className="secondary-button is-danger" type="button" data-action="delete-reminder" isDisabled={saving} onClick={() => modal.reminderId && onDelete(modal.reminderId)}>Delete</Button>
									</div>
								</div>
							)}
						</div>
							</form>
						</div>
					) : (
						<ReminderPickerSheet
							draft={draft}
							dialogRef={setDialogRef}
							projectOptions={projectOptions}
							onPatch={patchDraft}
							onSelect={returnToEditor}
							onClose={() => returnToEditor()}
						/>
					)}
				</div>
		</PwaModalSheet>
	);
}
