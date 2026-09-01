import React from 'react';
import { PwaButton as Button } from './PwaButton';
import {
	Check,
	X,
} from 'lucide-react';
import { formatLocalDateKey } from '@/reminders/utils/reminderDate';
import {
	getReminderDateForPreset,
	REMINDER_DATE_PRESETS,
	type ReminderDatePreset,
} from '@/reminders/ui/reminder-modal/datePresets';
import { REMINDER_PICKER_COPY } from '@/reminders/ui/reminder-modal/pickerCopy';
import {
	applyDateFieldsToDraft,
	applyDatePresetToDraft,
	formatModalDueSummary,
} from '../reminder-state';
import type { ModalDraft } from '../types';

function activePresetForDraft(draft: ModalDraft, now: Date): ReminderDatePreset | null {
	for (const { id } of REMINDER_DATE_PRESETS) {
		const expected = getReminderDateForPreset(id, now);
		if (draft.dueDate !== formatLocalDateKey(expected)) continue;
		if (id === 'evening' ? draft.dueTime === '18:00' : !draft.dueTime) return id;
	}
	return null;
}

export function ReminderDatePicker({
	draft,
	dialogRef,
	projectOptions,
	onPatch,
	onSelect,
	onClose,
}: {
	draft: ModalDraft;
	dialogRef: (element: HTMLElement | null) => void;
	projectOptions: string[];
	onPatch: (patch: Partial<ModalDraft>) => void;
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}) {
	const now = new Date();
	const activePreset = activePresetForDraft(draft, now);
	const dateFormatter = new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
	const timeFormatter = new Intl.DateTimeFormat(undefined, {
		hour: 'numeric',
		minute: '2-digit',
	});
	const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
	const hasSchedule = Boolean(draft.dueDate);

	return (
		<section ref={dialogRef} className="pwa-picker-sheet pwa-date-picker-sheet" role="dialog" aria-modal="true" aria-label={REMINDER_PICKER_COPY.schedule.dialogLabel} tabIndex={-1}>
			<div className="pwa-picker-header pwa-schedule-header">
				<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label={REMINDER_PICKER_COPY.schedule.closeLabel} onClick={onClose}>
					<X size={18} />
				</Button>
				<h3>{REMINDER_PICKER_COPY.schedule.title}</h3>
				<Button className="pwa-schedule-done" type="button" onClick={onClose}>
					{REMINDER_PICKER_COPY.schedule.done}
				</Button>
			</div>

			<div className="pwa-picker-content pwa-schedule-content">
				{hasSchedule && (
					<div className="pwa-schedule-current" aria-live="polite">
						<span>{REMINDER_PICKER_COPY.schedule.current}</span>
						<strong>{formatModalDueSummary(draft)}</strong>
					</div>
				)}

				<section className="pwa-schedule-section" aria-labelledby="quick-schedule-title">
					<div className="pwa-schedule-section__heading">
						<h4 id="quick-schedule-title">{REMINDER_PICKER_COPY.schedule.quickOptions}</h4>
					</div>
					<div className="pwa-schedule-preset-grid">
						{REMINDER_DATE_PRESETS.map(({ id, label }) => {
							const presetDate = getReminderDateForPreset(id, now);
							const detail = id === 'evening'
								? `${weekdayFormatter.format(presetDate)}, ${timeFormatter.format(presetDate)}`
								: dateFormatter.format(presetDate);
							const selected = activePreset === id;
							return (
								<Button
									key={id}
									className={`pwa-schedule-preset${selected ? ' is-active' : ''}`}
									type="button"
									aria-pressed={selected}
									data-action="apply-date-preset"
									data-preset={id}
									onClick={() => onSelect(applyDatePresetToDraft(draft, projectOptions, id))}
								>
									<span className="pwa-schedule-preset__copy"><strong>{label}</strong><small>{detail}</small></span>
									{selected && <Check className="pwa-schedule-preset__check" size={15} aria-hidden="true" />}
								</Button>
							);
						})}
					</div>
				</section>

				<section className="pwa-schedule-section" aria-labelledby="custom-schedule-title">
					<div className="pwa-schedule-section__heading">
						<h4 id="custom-schedule-title">{REMINDER_PICKER_COPY.schedule.custom}</h4>
					</div>
					<div className="pwa-schedule-fields">
						<label className="pwa-schedule-field">
							<span className="pwa-schedule-field__copy"><strong>{REMINDER_PICKER_COPY.schedule.date}</strong></span>
							<input
								type="date"
								value={draft.dueDate}
								onChange={(event) => onPatch(applyDateFieldsToDraft(draft, projectOptions, event.currentTarget.value, draft.dueTime))}
							/>
						</label>
						<label className="pwa-schedule-field">
							<span className="pwa-schedule-field__copy"><strong>{REMINDER_PICKER_COPY.schedule.time} <small>{REMINDER_PICKER_COPY.schedule.optional}</small></strong></span>
							<input
								type="time"
								value={draft.dueTime}
								onChange={(event) => onPatch(applyDateFieldsToDraft(draft, projectOptions, draft.dueDate || formatLocalDateKey(new Date()), event.currentTarget.value))}
							/>
						</label>
					</div>
				</section>

				{hasSchedule && (
					<Button
						className="pwa-schedule-clear"
						type="button"
						data-action="apply-date-preset"
						data-preset="clear"
						onClick={() => onSelect(applyDatePresetToDraft(draft, projectOptions, 'clear'))}
					>
						<X size={15} /> {REMINDER_PICKER_COPY.schedule.remove}
					</Button>
				)}
			</div>
		</section>
	);
}
