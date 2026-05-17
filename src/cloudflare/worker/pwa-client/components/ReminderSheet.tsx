import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
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
import {
	applyReminderTextUpdate,
	deriveDraftPatchFromContent,
	formatModalDueSummary,
} from '../reminder-state';
import type { ModalDraft, ModalPickerId, ModalState } from '../types';
import { ReminderPickerSheet } from './ReminderPickerSheet';

const SHEET_SWITCH_DELAY_MS = 220;

export function ReminderSheet({
	modal,
	projects,
	saving,
	onChange,
	onClose,
	onSave,
	onDelete,
}: {
	modal: ModalState;
	projects: string[];
	saving: boolean;
	onChange: React.Dispatch<React.SetStateAction<ModalState | null>>;
	onClose: () => void;
	onSave: (modal: ModalState) => void;
	onDelete: (id: string) => void;
}) {
	const contentRef = useRef<HTMLDivElement | null>(null);
	const richTextInputRef = useRef<RichTextInputHandle | null>(null);
	const editorCardRef = useRef<HTMLDivElement | null>(null);
	const switchTimerRef = useRef<number | null>(null);
	const [pendingPicker, setPendingPicker] = useState<ModalPickerId | null>(null);
	const [returningToEditor, setReturningToEditor] = useState(false);
	const draft = modal.draft;
	const projectOptions = ['Inbox', ...projects.filter((project) => project !== 'Inbox')];
	const isEditing = modal.mode === 'edit';
	const title = isEditing ? 'Edit Reminder' : 'New Reminder';
	const canSubmit = !saving && Boolean(draft.content.trim());

	useLayoutEffect(() => {
		const initialContent = draft.content.trim();
		const focusTitle = () => {
			const element = richTextInputRef.current?.getElement();
			const currentContent = element?.textContent?.trim() ?? '';
			if (element && currentContent !== initialContent) {
				if (currentContent === '') richTextInputRef.current?.focus();
				return;
			}
			richTextInputRef.current?.focus();
		};

		focusTitle();
		const frame = window.requestAnimationFrame(focusTitle);
		const timers = [60, 180, 320].map((delay) => window.setTimeout(focusTitle, delay));
		return () => {
			window.cancelAnimationFrame(frame);
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [draft.content, modal.mode, modal.reminderId]);

	useEffect(() => () => {
		if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
	}, []);

	useEffect(() => {
		setPendingPicker(null);
		setReturningToEditor(false);
		if (switchTimerRef.current !== null) {
			window.clearTimeout(switchTimerRef.current);
			switchTimerRef.current = null;
		}
	}, [modal.mode, modal.reminderId]);

	const patchDraft = (patch: Partial<ModalDraft>) => {
		onChange((current) => current ? ({ ...current, draft: { ...current.draft, ...patch } }) : current);
	};

	const autocomplete = useProjectAutocomplete({
		content: draft.content,
		projects: projectOptions,
		onContentChange: (content) => patchDraft({ content }),
		richTextInputRef,
	});

	useEffect(() => {
		if (draft.activePicker || pendingPicker || returningToEditor) return;
		const patch = deriveDraftPatchFromContent(draft, projectOptions);
		if (Object.keys(patch).length > 0) {
			patchDraft(patch);
		}
	}, [draft.content, draft.activePicker, pendingPicker, returningToEditor, projectOptions.join('\u0000')]);

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

	const togglePicker = (picker: ModalPickerId) => {
		if (switchTimerRef.current !== null) return;
		if (draft.activePicker === picker) {
			returnToEditor();
			return;
		}

		setPendingPicker(picker);
		switchTimerRef.current = window.setTimeout(() => {
			switchTimerRef.current = null;
			setPendingPicker(null);
			patchDraft({ activePicker: picker, deleteConfirm: false });
		}, SHEET_SWITCH_DELAY_MS);
	};

	const returnToEditor = (patch: Partial<ModalDraft> = {}) => {
		if (switchTimerRef.current !== null) return;
		setPendingPicker(null);
		setReturningToEditor(true);
		if (Object.keys(patch).length) patchDraft({ ...patch, deleteConfirm: false });
		switchTimerRef.current = window.setTimeout(() => {
			switchTimerRef.current = null;
			setReturningToEditor(false);
			patchDraft({ activePicker: null, deleteConfirm: false });
		}, SHEET_SWITCH_DELAY_MS);
	};

	return (
		<div className="modal-backdrop pwa-reminder-editor-backdrop" onClick={(event) => {
			if (event.target !== event.currentTarget) return;
			if (draft.activePicker) returnToEditor();
			else onClose();
		}}>
			{draft.activePicker ? (
				<ReminderPickerSheet
					draft={draft}
					projectOptions={projectOptions}
					isSwitchingOut={returningToEditor}
					onPatch={patchDraft}
					onSelect={returnToEditor}
					onClose={() => returnToEditor()}
				/>
			) : (
				<div className={`modal-card pwa-reminder-editor${pendingPicker ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
					<form className="modal-form" onSubmit={(event) => {
						event.preventDefault();
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
								inputRef={contentRef}
								preserveSelection={!pendingPicker && !returningToEditor}
								knownProjects={projectOptions}
								onAutocompleteQuery={autocomplete.updateAutocomplete}
								onAutocompleteKeyDown={autocomplete.handleKeyDown}
								className="pwa-editor-title-input pwa-editor-title-rich-input ios-scroll"
							/>
							{autocomplete.isOpen && (
								<ProjectAutocompleteDropdown
									filteredProjects={autocomplete.filteredProjects}
									highlightedIndex={autocomplete.highlightedIndex}
									anchorRect={autocomplete.rect}
									containerRef={editorCardRef}
									isDark
									onSelect={autocomplete.selectProject}
								/>
							)}
							<div className="pwa-editor-divider" />
							<textarea
								data-draft-field="description"
								className="pwa-editor-description-input ios-scroll"
								rows={3}
								maxLength={4096}
								placeholder="Add description..."
								value={draft.description}
								onChange={(event) => patchDraft({ description: event.currentTarget.value })}
							/>
						</div>

						<div className="pwa-editor-chip-row">
							<Button
								className={`pwa-editor-chip${draft.dueDate ? ' is-active' : ''}`}
								type="button"
								data-action="toggle-picker"
								data-picker="date"
								isDisabled={Boolean(pendingPicker)}
								onClick={() => togglePicker('date')}
							>
								<Calendar size={16} />
								<span>{draft.dueDate ? formatModalDueSummary(draft) : 'Date'}</span>
							</Button>
							<Button
								className="pwa-editor-chip"
								type="button"
								data-action="toggle-picker"
								data-picker="project"
								isDisabled={Boolean(pendingPicker)}
								onClick={() => togglePicker('project')}
							>
								<Hash size={16} />
								<span>{draft.project || 'Inbox'}</span>
							</Button>
							<Button
								isIconOnly
								className={`pwa-editor-chip pwa-editor-chip--icon${draft.priority === 1 ? ' is-important' : ''}`}
								type="button"
								data-action="toggle-priority"
								aria-label="Toggle priority"
								onClick={() => patchDraft({
									...applyReminderTextUpdate(draft, projectOptions, { priority: draft.priority === 1 ? 4 : 1 }),
									activePicker: null,
								})}
							>
								<Flag size={16} fill={draft.priority === 1 ? 'currentColor' : 'none'} />
							</Button>
							<Button
								isIconOnly
								className={`pwa-editor-chip pwa-editor-chip--icon${draft.recurrence ? ' is-active' : ''}`}
								type="button"
								data-action="toggle-picker"
								data-picker="recurrence"
								isDisabled={Boolean(pendingPicker)}
								aria-label={draft.recurrence ? formatRecurrence(draft.recurrence) : 'Recurrence'}
								onClick={() => togglePicker('recurrence')}
							>
								<Repeat size={16} />
							</Button>
						</div>

						{isEditing && draft.deleteConfirm && (
							<div className="delete-confirm">
								<div>
									<strong>Delete this reminder?</strong>
									<p>This removes it from the original markdown file and cancels its scheduled notification.</p>
								</div>
								<div className="delete-confirm__actions">
									<Button className="secondary-button" type="button" onClick={() => patchDraft({ deleteConfirm: false })}>Keep it</Button>
									<Button className="secondary-button is-danger" type="button" data-action="delete-reminder" onClick={() => modal.reminderId && onDelete(modal.reminderId)}>Delete</Button>
								</div>
							</div>
						)}
					</form>
				</div>
			)}
		</div>
	);
}
