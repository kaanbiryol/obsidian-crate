import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import {
	ArrowUp,
	Calendar,
	Check,
	ChevronLeft,
	Flag,
	Hash,
	Repeat,
	Trash2,
	X,
} from 'lucide-react';
import { RichTextInput, type RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ProjectAutocompleteDropdown } from '@/reminders/components/ProjectAutocompleteDropdown';
import { useProjectAutocomplete } from '@/reminders/components/useProjectAutocomplete';
import type { RecurrenceRule } from '@/reminders/types/reminder';
import { getProjectColor } from '@/reminders/utils/projectColors';
import { formatLocalDateKey } from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { formatRecurrence } from '@/reminders/utils/rruleConverter';
import {
	applyDateFieldsToDraft,
	applyDatePresetToDraft,
	applyReminderTextUpdate,
	deriveDraftPatchFromContent,
	formatModalDueSummary,
} from '../reminder-state';
import type { ModalDraft, ModalPickerId, ModalState } from '../types';

const SHEET_SWITCH_DELAY_MS = 220;
const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
const RECURRENCE_DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

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
				<PickerSheet
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

interface RecurrencePickerDraft {
	frequency: RecurrenceRule['frequency'];
	interval: number;
	daysOfWeek: number[];
	dayOfMonth: number;
	time: string;
}

function buildRecurrencePickerDraft(rule: RecurrenceRule | undefined): RecurrencePickerDraft {
	return {
		frequency: rule?.frequency ?? 'daily',
		interval: rule?.interval ?? 1,
		daysOfWeek: rule?.daysOfWeek ?? [],
		dayOfMonth: rule?.dayOfMonth ?? new Date().getDate(),
		time: `${String(rule?.hour ?? 9).padStart(2, '0')}:${String(rule?.minute ?? 0).padStart(2, '0')}`,
	};
}

function getOrdinalSuffix(value: number): string {
	const endings = ['th', 'st', 'nd', 'rd'];
	const mod = value % 100;
	return `${value}${endings[(mod - 20) % 10] || endings[mod] || endings[0]}`;
}

function recurrenceRuleFromPicker(draft: RecurrencePickerDraft): RecurrenceRule {
	const [rawHour, rawMinute] = draft.time.split(':').map(Number);
	const hour = Number.isInteger(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 9;
	const minute = Number.isInteger(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0;
	const rule: RecurrenceRule = {
		frequency: draft.frequency,
		hour,
		minute,
	};

	if (draft.interval > 1) rule.interval = draft.interval;
	if (draft.frequency === 'weekly' && draft.daysOfWeek.length > 0) rule.daysOfWeek = draft.daysOfWeek;
	if (draft.frequency === 'monthly') rule.dayOfMonth = Math.min(31, Math.max(1, draft.dayOfMonth));

	return normalizeRecurrenceRule(rule) ?? rule;
}

function PickerSheet({
	draft,
	projectOptions,
	isSwitchingOut,
	onPatch,
	onSelect,
	onClose,
}: {
	draft: ModalDraft;
	projectOptions: string[];
	isSwitchingOut: boolean;
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}) {
	const [recurrenceDraft, setRecurrenceDraft] = useState(() => buildRecurrencePickerDraft(draft.recurrence));

	useEffect(() => {
		if (draft.activePicker !== 'recurrence') return;
		setRecurrenceDraft(buildRecurrencePickerDraft(draft.recurrence));
	}, [draft.activePicker, draft.recurrence]);

	if (!draft.activePicker) return null;

	if (draft.activePicker === 'date') {
		return (
			<section className={`pwa-picker-sheet${isSwitchingOut ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label="Schedule reminder">
				<div className="pwa-picker-header">
					<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label="Close schedule" onClick={onClose}>
						<X size={20} />
					</Button>
					<h3>Schedule</h3>
					<Button isIconOnly className="pwa-picker-icon-button pwa-picker-icon-button--done" type="button" aria-label="Done" onClick={onClose}>
						<Check size={20} />
					</Button>
				</div>
				<div className="pwa-picker-content">
					<div className="pwa-picker-presets">
						{([
							['today', 'Today'],
							['tomorrow', 'Tomorrow'],
							['evening', 'This evening'],
							['next-week', 'Next week'],
							['clear', 'No date'],
						] as const).map(([preset, label]) => (
							<Button
								key={preset}
								className={`pwa-picker-option${preset === 'clear' ? ' is-danger' : ''}`}
								type="button"
								data-action="apply-date-preset"
								data-preset={preset}
								onClick={() => onSelect(applyDatePresetToDraft(draft, projectOptions, preset))}
							>
								<span>{label}</span>
								{preset === 'clear' ? <X size={16} /> : <Calendar size={16} />}
							</Button>
						))}
					</div>
					<div className="pwa-picker-fields">
						<label className="pwa-picker-field">
							<span>Date</span>
							<input
								data-draft-field="dueDate"
								type="date"
								value={draft.dueDate}
								onChange={(event) => onPatch(applyDateFieldsToDraft(draft, projectOptions, event.currentTarget.value, draft.dueTime))}
							/>
						</label>
						<label className="pwa-picker-field">
							<span>Time</span>
							<input
								data-draft-field="dueTime"
								type="time"
								value={draft.dueTime}
								onChange={(event) => onPatch(applyDateFieldsToDraft(draft, projectOptions, draft.dueDate || formatLocalDateKey(new Date()), event.currentTarget.value))}
							/>
						</label>
					</div>
				</div>
			</section>
		);
	}

	if (draft.activePicker === 'project') {
		return (
			<section className={`pwa-picker-sheet pwa-project-picker-sheet${isSwitchingOut ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label="Select Project">
				<div className="pwa-picker-header pwa-project-picker-header">
					<Button isIconOnly className="pwa-picker-icon-button pwa-project-picker-back" type="button" aria-label="Back to reminder" onClick={onClose}>
						<ChevronLeft size={22} />
					</Button>
					<h3>Select Project</h3>
					<span aria-hidden="true" />
				</div>
				<div className="pwa-picker-content">
					<div className="pwa-project-list ios-scroll" role="listbox" aria-label="Project selection">
						{projectOptions.map((project) => {
							const colors = getProjectColor(project);
							const selected = draft.project === project;
							return (
								<Button
									key={project}
									className={`pwa-project-option${selected ? ' is-active' : ''}`}
									type="button"
									role="option"
									aria-selected={selected}
									data-action="select-project"
									data-project={project}
									onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, { project }))}
								>
									<span className="pwa-project-option__label">
										<span
											className="pwa-project-dot"
											style={{ '--project-color': colors.dark.accent } as React.CSSProperties}
											aria-hidden="true"
										/>
										<span className="pwa-project-option__name">{project}</span>
									</span>
									{selected ? <Check size={18} /> : null}
								</Button>
							);
						})}
					</div>
				</div>
			</section>
		);
	}

	return (
		<section className={`pwa-picker-sheet pwa-recurrence-picker-sheet${isSwitchingOut ? ' is-switching-out' : ''}`} role="dialog" aria-modal="true" aria-label="Repeat reminder">
			<div className="pwa-picker-header">
				<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label="Back to reminder" onClick={onClose}>
					<ChevronLeft size={20} />
				</Button>
				<h3>{draft.recurrence ? formatRecurrence(draft.recurrence) : 'Repeat'}</h3>
				<Button
					isIconOnly
					className="pwa-picker-icon-button pwa-picker-icon-button--done"
					type="button"
					aria-label="Apply repeat"
					onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, {
						recurrence: recurrenceRuleFromPicker(recurrenceDraft),
						dueDateValue: null,
						hasTime: false,
					}))}
				>
					<Check size={20} />
				</Button>
			</div>
			<div className="pwa-picker-content">
				<div className="pwa-recurrence-segmented" role="tablist" aria-label="Repeat frequency">
					{RECURRENCE_FREQUENCIES.map((frequency) => (
						<Button
							key={frequency}
							className={`pwa-recurrence-segment${recurrenceDraft.frequency === frequency ? ' is-active' : ''}`}
							type="button"
							role="tab"
							aria-selected={recurrenceDraft.frequency === frequency}
							onClick={() => setRecurrenceDraft((current) => ({ ...current, frequency }))}
						>
							{frequency[0].toUpperCase() + frequency.slice(1)}
						</Button>
					))}
				</div>

				{recurrenceDraft.frequency === 'daily' && (
					<div className="pwa-recurrence-stepper">
						<span>Every</span>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, interval: Math.max(1, current.interval - 1) }))}>-</Button>
						<strong>{recurrenceDraft.interval}</strong>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, interval: Math.min(30, current.interval + 1) }))}>+</Button>
						<span>{recurrenceDraft.interval === 1 ? 'day' : 'days'}</span>
					</div>
				)}

				{recurrenceDraft.frequency === 'weekly' && (
					<div className="pwa-recurrence-days" aria-label="Repeat days">
						{RECURRENCE_DAY_LABELS.map((label, index) => {
							const selected = recurrenceDraft.daysOfWeek.includes(index);
							return (
								<Button
									isIconOnly
									key={`${label}-${index}`}
									className={`pwa-recurrence-day${selected ? ' is-active' : ''}`}
									type="button"
									aria-pressed={selected}
									onClick={() => setRecurrenceDraft((current) => ({
										...current,
										daysOfWeek: selected
											? current.daysOfWeek.filter((day) => day !== index)
											: [...current.daysOfWeek, index].sort((a, b) => a - b),
									}))}
								>
									{label}
								</Button>
							);
						})}
					</div>
				)}

				{recurrenceDraft.frequency === 'monthly' && (
					<div className="pwa-recurrence-stepper">
						<span>Day</span>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, dayOfMonth: Math.max(1, current.dayOfMonth - 1) }))}>-</Button>
						<strong>{getOrdinalSuffix(recurrenceDraft.dayOfMonth)}</strong>
						<Button isIconOnly className="pwa-recurrence-stepper__button" type="button" onClick={() => setRecurrenceDraft((current) => ({ ...current, dayOfMonth: Math.min(31, current.dayOfMonth + 1) }))}>+</Button>
						<span>of month</span>
					</div>
				)}

				<label className="pwa-picker-field pwa-recurrence-time-field">
					<span>Time</span>
					<input type="time" value={recurrenceDraft.time} onChange={(event) => setRecurrenceDraft((current) => ({ ...current, time: event.currentTarget.value }))} />
				</label>

				{draft.recurrence && (
					<Button className="pwa-picker-option is-danger" type="button" onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, { recurrence: null, dueDateValue: null, hasTime: false }))}>
						<span>Remove repeat</span>
						<X size={16} />
					</Button>
				)}
			</div>
		</section>
	);
}
