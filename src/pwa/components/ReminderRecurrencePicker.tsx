import React, { useEffect, useState } from 'react';
import { PwaButton as Button } from './PwaButton';
import {
	Minus,
	Plus,
	X,
} from 'lucide-react';
import {
	RECURRENCE_FREQUENCIES,
	buildRecurrencePickerDraft,
	getRecurrenceDayLabels,
	getRecurrenceDayNames,
	getOrdinalSuffix,
	recurrenceRuleFromPickerDraft,
	type RecurrencePickerDraft,
} from '@/reminders/ui/reminder-modal/recurrencePickerShared';
import { REMINDER_PICKER_COPY } from '@/reminders/ui/reminder-modal/pickerCopy';
import { formatRecurrence } from '@/reminders/utils/rruleConverter';
import { applyReminderTextUpdate } from '../reminder-state';
import type { ModalDraft } from '../types';

const FREQUENCY_DETAILS = {
	daily: { label: 'Daily', unit: 'day' },
	weekly: { label: 'Weekly', unit: 'week' },
	monthly: { label: 'Monthly', unit: 'month' },
} as const;

function RepeatStepper({
	label,
	detail,
	value,
	onDecrease,
	onIncrease,
	decreaseDisabled,
	increaseDisabled,
}: {
	label: string;
	detail: string;
	value: React.ReactNode;
	onDecrease: () => void;
	onIncrease: () => void;
	decreaseDisabled: boolean;
	increaseDisabled: boolean;
}) {
	return (
		<div className="pwa-repeat-control-card">
			<div className="pwa-repeat-control-card__copy"><strong>{label}</strong><span>{detail}</span></div>
			<div className="pwa-repeat-stepper">
				<Button isIconOnly className="pwa-repeat-stepper__button" type="button" aria-label={`Decrease ${label.toLowerCase()}`} isDisabled={decreaseDisabled} onClick={onDecrease}><Minus size={16} /></Button>
				<strong className="pwa-repeat-stepper__value" aria-live="polite">{value}</strong>
				<Button isIconOnly className="pwa-repeat-stepper__button" type="button" aria-label={`Increase ${label.toLowerCase()}`} isDisabled={increaseDisabled} onClick={onIncrease}><Plus size={16} /></Button>
			</div>
		</div>
	);
}

export function ReminderRecurrencePicker({
	draft,
	dialogRef,
	projectOptions,
	onSelect,
	onClose,
}: {
	draft: ModalDraft;
	dialogRef: (element: HTMLElement | null) => void;
	projectOptions: string[];
	onSelect: (patch?: Partial<ModalDraft>) => void;
	onClose: () => void;
}) {
	const [recurrenceDraft, setRecurrenceDraft] = useState<RecurrencePickerDraft>(() => buildRecurrencePickerDraft(draft.recurrence));
	const dayLabels = getRecurrenceDayLabels();
	const dayNames = getRecurrenceDayNames();

	useEffect(() => {
		setRecurrenceDraft(buildRecurrencePickerDraft(draft.recurrence));
	}, [draft.recurrence]);

	const liveRule = recurrenceRuleFromPickerDraft(recurrenceDraft);
	const frequency = FREQUENCY_DETAILS[recurrenceDraft.frequency];
	const intervalDetail = recurrenceDraft.interval === 1 ? frequency.unit : `${frequency.unit}s`;
	const applyRepeat = () => onSelect(applyReminderTextUpdate(draft, projectOptions, {
		recurrence: liveRule,
		dueDateValue: null,
		hasTime: false,
	}));

	return (
		<section ref={dialogRef} className="pwa-picker-sheet pwa-repeat-picker-sheet" role="dialog" aria-modal="true" aria-label={REMINDER_PICKER_COPY.repeat.dialogLabel} tabIndex={-1}>
			<div className="pwa-picker-header pwa-repeat-header">
				<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label={REMINDER_PICKER_COPY.repeat.closeLabel} onClick={onClose}>
					<X size={18} />
				</Button>
				<h3>{REMINDER_PICKER_COPY.repeat.title}</h3>
				<Button className="pwa-repeat-apply" type="button" onClick={applyRepeat}>
					{REMINDER_PICKER_COPY.repeat.done}
				</Button>
			</div>

			<div className="pwa-picker-content pwa-repeat-content">
				<div className="pwa-repeat-summary" aria-live="polite">
					<span>{REMINDER_PICKER_COPY.repeat.current}</span>
					<strong>{formatRecurrence(liveRule)}</strong>
				</div>

				<section className="pwa-repeat-section" aria-labelledby="repeat-frequency-title">
					<div className="pwa-repeat-section__heading">
						<h4 id="repeat-frequency-title">{REMINDER_PICKER_COPY.repeat.frequency}</h4>
					</div>
					<div className="pwa-repeat-frequency-grid" role="tablist" aria-label="Repeat frequency">
						{RECURRENCE_FREQUENCIES.map((option) => {
							const { label } = FREQUENCY_DETAILS[option];
							const selected = recurrenceDraft.frequency === option;
							return (
								<Button
									key={option}
									className={`pwa-repeat-frequency${selected ? ' is-active' : ''}`}
									type="button"
									role="tab"
									aria-selected={selected}
									onClick={() => setRecurrenceDraft((current) => ({ ...current, frequency: option }))}
								>
									<span>{label}</span>
								</Button>
							);
						})}
					</div>
				</section>

				<section className="pwa-repeat-section" aria-labelledby="repeat-interval-title">
					<div className="pwa-repeat-section__heading">
						<h4 id="repeat-interval-title">{REMINDER_PICKER_COPY.repeat.interval}</h4>
					</div>
					<RepeatStepper
						label={REMINDER_PICKER_COPY.repeat.every}
						detail={intervalDetail}
						value={recurrenceDraft.interval}
						decreaseDisabled={recurrenceDraft.interval <= 1}
						increaseDisabled={recurrenceDraft.interval >= 30}
						onDecrease={() => setRecurrenceDraft((current) => ({ ...current, interval: Math.max(1, current.interval - 1) }))}
						onIncrease={() => setRecurrenceDraft((current) => ({ ...current, interval: Math.min(30, current.interval + 1) }))}
					/>
				</section>

				{recurrenceDraft.frequency === 'weekly' && (
					<section className="pwa-repeat-section" aria-labelledby="repeat-days-title">
						<div className="pwa-repeat-section__heading">
							<h4 id="repeat-days-title">{REMINDER_PICKER_COPY.repeat.days}</h4>
						</div>
						<div className="pwa-repeat-days" aria-label="Repeat days">
							{dayLabels.map((label, index) => {
								const selected = recurrenceDraft.daysOfWeek.includes(index);
								return (
									<Button
										isIconOnly
										key={`${label}-${index}`}
										className={`pwa-repeat-day${selected ? ' is-active' : ''}`}
										type="button"
										aria-label={dayNames[index]}
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
					</section>
				)}

				{recurrenceDraft.frequency === 'monthly' && (
					<section className="pwa-repeat-section" aria-labelledby="repeat-month-day-title">
						<div className="pwa-repeat-section__heading">
							<h4 id="repeat-month-day-title">{REMINDER_PICKER_COPY.repeat.monthDay}</h4>
						</div>
						<RepeatStepper
							label={REMINDER_PICKER_COPY.repeat.dayOfMonth}
							detail={REMINDER_PICKER_COPY.repeat.calendarDate}
							value={getOrdinalSuffix(recurrenceDraft.dayOfMonth)}
							decreaseDisabled={recurrenceDraft.dayOfMonth <= 1}
							increaseDisabled={recurrenceDraft.dayOfMonth >= 31}
							onDecrease={() => setRecurrenceDraft((current) => ({ ...current, dayOfMonth: Math.max(1, current.dayOfMonth - 1) }))}
							onIncrease={() => setRecurrenceDraft((current) => ({ ...current, dayOfMonth: Math.min(31, current.dayOfMonth + 1) }))}
						/>
					</section>
				)}

				<section className="pwa-repeat-section" aria-labelledby="repeat-time-title">
					<div className="pwa-repeat-section__heading">
						<h4 id="repeat-time-title">{REMINDER_PICKER_COPY.repeat.time}</h4>
					</div>
					<label className="pwa-repeat-time-card">
					<span className="pwa-repeat-time-card__copy"><strong>{REMINDER_PICKER_COPY.repeat.reminderTime}</strong></span>
						<input type="time" value={recurrenceDraft.time} onChange={(event) => setRecurrenceDraft((current) => ({ ...current, time: event.currentTarget.value }))} />
					</label>
				</section>

				{draft.recurrence && (
					<Button className="pwa-repeat-remove" type="button" onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, { recurrence: null, dueDateValue: null, hasTime: false }))}>
						<X size={15} /> {REMINDER_PICKER_COPY.repeat.remove}
					</Button>
				)}
			</div>
		</section>
	);
}
