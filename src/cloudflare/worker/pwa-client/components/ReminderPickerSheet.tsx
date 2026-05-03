import React, { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { Calendar, Check, ChevronLeft, X } from 'lucide-react';
import {
	RECURRENCE_DAY_LABELS,
	RECURRENCE_FREQUENCIES,
	buildRecurrencePickerDraft,
	getOrdinalSuffix,
	recurrenceRuleFromPickerDraft,
} from '@/reminders/components/addReminderModal/recurrencePickerShared';
import { getProjectColor } from '@/reminders/utils/projectColors';
import { formatLocalDateKey } from '@/reminders/utils/reminderDate';
import { formatRecurrence } from '@/reminders/utils/rruleConverter';
import {
	applyDateFieldsToDraft,
	applyDatePresetToDraft,
	applyReminderTextUpdate,
} from '../reminder-state';
import type { ModalDraft } from '../types';

interface ReminderPickerSheetProps {
	draft: ModalDraft;
	projectOptions: string[];
	isSwitchingOut: boolean;
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}

export function ReminderPickerSheet({
	draft,
	projectOptions,
	isSwitchingOut,
	onPatch,
	onSelect,
	onClose,
}: ReminderPickerSheetProps) {
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
						recurrence: recurrenceRuleFromPickerDraft(recurrenceDraft),
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
