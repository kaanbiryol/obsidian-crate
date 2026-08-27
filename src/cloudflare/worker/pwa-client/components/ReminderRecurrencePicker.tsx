import React, { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import {
	Minus,
	Plus,
	X,
} from 'lucide-react';
import {
	RECURRENCE_DAY_LABELS,
	RECURRENCE_FREQUENCIES,
	buildRecurrencePickerDraft,
	getOrdinalSuffix,
	recurrenceRuleFromPickerDraft,
	type RecurrencePickerDraft,
} from '@/reminders/ui/reminder-modal/recurrencePickerShared';
import { formatRecurrence } from '@/reminders/utils/rruleConverter';
import { applyReminderTextUpdate } from '../reminder-state';
import type { ModalDraft } from '../types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
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
		<section ref={dialogRef} className="pwa-picker-sheet pwa-repeat-picker-sheet" role="dialog" aria-modal="true" aria-label="Repeat reminder" tabIndex={-1}>
			<div className="pwa-picker-header pwa-repeat-header">
				<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label="Close repeat" onClick={onClose}>
					<X size={18} />
				</Button>
				<h3>Repeat</h3>
				<Button className="pwa-repeat-apply" type="button" onClick={applyRepeat}>
					Apply
				</Button>
			</div>

			<div className="pwa-picker-content pwa-repeat-content">
				<div className="pwa-repeat-summary" aria-live="polite">
					<span>Repeats</span>
					<strong>{formatRecurrence(liveRule)}</strong>
				</div>

				<section className="pwa-repeat-section" aria-labelledby="repeat-frequency-title">
					<div className="pwa-repeat-section__heading">
						<h4 id="repeat-frequency-title">Frequency</h4>
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
						<h4 id="repeat-interval-title">Interval</h4>
					</div>
					<RepeatStepper
						label="Every"
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
							<h4 id="repeat-days-title">Days</h4>
						</div>
						<div className="pwa-repeat-days" aria-label="Repeat days">
							{RECURRENCE_DAY_LABELS.map((label, index) => {
								const selected = recurrenceDraft.daysOfWeek.includes(index);
								return (
									<Button
										isIconOnly
										key={`${label}-${index}`}
										className={`pwa-repeat-day${selected ? ' is-active' : ''}`}
										type="button"
										aria-label={DAY_NAMES[index]}
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
							<h4 id="repeat-month-day-title">Month day</h4>
						</div>
						<RepeatStepper
							label="Day of month"
							detail="Calendar date"
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
						<h4 id="repeat-time-title">Time</h4>
					</div>
					<label className="pwa-repeat-time-card">
						<span className="pwa-repeat-time-card__copy"><strong>Reminder time</strong></span>
						<input type="time" value={recurrenceDraft.time} onChange={(event) => setRecurrenceDraft((current) => ({ ...current, time: event.currentTarget.value }))} />
					</label>
				</section>

				{draft.recurrence && (
					<Button className="pwa-repeat-remove" type="button" onClick={() => onSelect(applyReminderTextUpdate(draft, projectOptions, { recurrence: null, dueDateValue: null, hasTime: false }))}>
						<X size={15} /> Remove repeat
					</Button>
				)}
			</div>
		</section>
	);
}
