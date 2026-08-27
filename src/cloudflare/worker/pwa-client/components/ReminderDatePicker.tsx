import React from 'react';
import { Button } from '@heroui/react';
import {
	Check,
	X,
} from 'lucide-react';
import { formatLocalDateKey } from '@/reminders/utils/reminderDate';
import {
	applyDateFieldsToDraft,
	applyDatePresetToDraft,
	formatModalDueSummary,
} from '../reminder-state';
import type { ModalDraft } from '../types';

type DatePreset = 'today' | 'tomorrow' | 'evening' | 'next-week';

const DATE_PRESETS = [
	{ preset: 'today', label: 'Today' },
	{ preset: 'tomorrow', label: 'Tomorrow' },
	{ preset: 'evening', label: 'This evening' },
	{ preset: 'next-week', label: 'Next week' },
] as const;

function dateForPreset(preset: DatePreset, now: Date): Date {
	const date = new Date(now);
	if (preset === 'tomorrow') date.setDate(date.getDate() + 1);
	if (preset === 'evening' && date.getHours() >= 18) date.setDate(date.getDate() + 1);
	if (preset === 'next-week') date.setDate(date.getDate() + 7);
	date.setHours(preset === 'evening' ? 18 : 0, 0, 0, 0);
	return date;
}

function activePresetForDraft(draft: ModalDraft, now: Date): DatePreset | null {
	for (const { preset } of DATE_PRESETS) {
		const expected = dateForPreset(preset, now);
		if (draft.dueDate !== formatLocalDateKey(expected)) continue;
		if (preset === 'evening' ? draft.dueTime === '18:00' : !draft.dueTime) return preset;
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
		<section ref={dialogRef} className="pwa-picker-sheet pwa-date-picker-sheet" role="dialog" aria-modal="true" aria-label="Schedule reminder" tabIndex={-1}>
			<div className="pwa-picker-header pwa-schedule-header">
				<Button isIconOnly className="pwa-picker-icon-button" type="button" aria-label="Close schedule" onClick={onClose}>
					<X size={18} />
				</Button>
				<h3>Schedule</h3>
				<Button className="pwa-schedule-done" type="button" onClick={onClose}>
					Done
				</Button>
			</div>

			<div className="pwa-picker-content pwa-schedule-content">
				{hasSchedule && (
					<div className="pwa-schedule-current" aria-live="polite">
						<span>Scheduled</span>
						<strong>{formatModalDueSummary(draft)}</strong>
					</div>
				)}

				<section className="pwa-schedule-section" aria-labelledby="quick-schedule-title">
					<div className="pwa-schedule-section__heading">
						<h4 id="quick-schedule-title">Quick options</h4>
					</div>
					<div className="pwa-schedule-preset-grid">
						{DATE_PRESETS.map(({ preset, label }) => {
							const presetDate = dateForPreset(preset, now);
							const detail = preset === 'evening'
								? `${weekdayFormatter.format(presetDate)}, ${timeFormatter.format(presetDate)}`
								: dateFormatter.format(presetDate);
							const selected = activePreset === preset;
							return (
								<Button
									key={preset}
									className={`pwa-schedule-preset${selected ? ' is-active' : ''}`}
									type="button"
									aria-pressed={selected}
									data-action="apply-date-preset"
									data-preset={preset}
									onClick={() => onSelect(applyDatePresetToDraft(draft, projectOptions, preset))}
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
						<h4 id="custom-schedule-title">Custom</h4>
					</div>
					<div className="pwa-schedule-fields">
						<label className="pwa-schedule-field">
							<span className="pwa-schedule-field__copy"><strong>Date</strong></span>
							<input
								type="date"
								value={draft.dueDate}
								onChange={(event) => onPatch(applyDateFieldsToDraft(draft, projectOptions, event.currentTarget.value, draft.dueTime))}
							/>
						</label>
						<label className="pwa-schedule-field">
							<span className="pwa-schedule-field__copy"><strong>Time <small>Optional</small></strong></span>
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
						<X size={15} /> Remove schedule
					</Button>
				)}
			</div>
		</section>
	);
}
