import { AnimatePresence } from 'framer-motion';
import type { ReactNode } from 'react';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { IconButton } from '../../components/IconButton';
import {
	getRecurrenceDayLabels,
	getRecurrenceDayNames,
	getOrdinalSuffix,
} from './recurrencePickerShared';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { PickerFieldRow } from './PickerFieldRow';
import { PickerSection } from './PickerSection';

const FREQUENCY_UNITS: Record<RecurrenceRule['frequency'], string> = {
	daily: 'day',
	weekly: 'week',
	monthly: 'month',
};

interface RecurrenceFrequencyOptionsProps {
	frequency: RecurrenceRule['frequency'];
	animationsEnabled: boolean;
	interval: number;
	selectedDays: number[];
	dayOfMonth: number;
	onIntervalChange: (value: number) => void;
	onToggleDay: (dayIndex: number) => void;
	onDayOfMonthChange: (value: number) => void;
}

function StepperControl({
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
	value: ReactNode;
	onDecrease: () => void;
	onIncrease: () => void;
	decreaseDisabled?: boolean;
	increaseDisabled?: boolean;
}) {
	return (
		<PickerFieldRow
			label={label}
			detail={detail}
			detailPlacement="inline"
			className="recurrence-option-row"
		>
			<div className="recurrence-stepper">
				<IconButton
					icon="minus"
					iconSize="s"
					size="small"
					label={`Decrease ${label.toLowerCase()}`}
					disabled={decreaseDisabled}
					onClick={onDecrease}
					className="recurrence-stepper-button"
				/>
				<strong className="recurrence-stepper-value" aria-live="polite">{value}</strong>
				<IconButton
					icon="plus"
					iconSize="s"
					size="small"
					label={`Increase ${label.toLowerCase()}`}
					disabled={increaseDisabled}
					onClick={onIncrease}
					className="recurrence-stepper-button"
				/>
			</div>
		</PickerFieldRow>
	);
}

export function RecurrenceFrequencyOptions({
	frequency,
	animationsEnabled,
	interval,
	selectedDays,
	dayOfMonth,
	onIntervalChange,
	onToggleDay,
	onDayOfMonthChange,
}: RecurrenceFrequencyOptionsProps) {
	const dayLabels = getRecurrenceDayLabels();
	const dayNames = getRecurrenceDayNames();
	const intervalUnit = FREQUENCY_UNITS[frequency];
	const intervalDetail = interval === 1 ? intervalUnit : `${intervalUnit}s`;
	const transitionProps = {
		initial: animationsEnabled ? { opacity: 0 } : false,
		animate: { opacity: 1 },
		exit: animationsEnabled ? { opacity: 0 } : undefined,
		transition: { duration: 0.15 },
	};

	return (
		<div
			className="recurrence-options"
			id="recurrence-options-panel"
			role="tabpanel"
			aria-labelledby={`recurrence-frequency-${frequency}`}
			tabIndex={-1}
		>
			<PickerSection
				headingId="plugin-repeat-interval-title"
				title={REMINDER_PICKER_COPY.repeat.interval}
			>
				<StepperControl
					label={REMINDER_PICKER_COPY.repeat.every}
					detail={intervalDetail}
					value={interval}
					decreaseDisabled={interval <= 1}
					increaseDisabled={interval >= 30}
					onDecrease={() => onIntervalChange(Math.max(1, interval - 1))}
					onIncrease={() => onIntervalChange(Math.min(30, interval + 1))}
				/>
			</PickerSection>

			<AnimatePresence mode="wait">
				{frequency === 'weekly' && (
					<PickerSection
						key="weekly-days"
						headingId="plugin-repeat-days-title"
						title={REMINDER_PICKER_COPY.repeat.days}
						motionProps={transitionProps}
					>
						<div className="recurrence-day-list" aria-label="Repeat days">
							{dayLabels.map((label, idx) => {
								const isSelected = selectedDays.includes(idx);
								return (
									<ShadowDOMNativeButton
										key={idx}
										onClick={() => onToggleDay(idx)}
										aria-label={dayNames[idx]}
										aria-pressed={isSelected}
										className={`recurrence-day-button${isSelected ? ' is-selected' : ''}`}
									>
										{label}
									</ShadowDOMNativeButton>
								);
							})}
						</div>
					</PickerSection>
				)}

				{frequency === 'monthly' && (
					<PickerSection
						key="monthly-day"
						headingId="plugin-repeat-month-day-title"
						title={REMINDER_PICKER_COPY.repeat.monthDay}
						motionProps={transitionProps}
					>
						<StepperControl
							label={REMINDER_PICKER_COPY.repeat.dayOfMonth}
							detail={REMINDER_PICKER_COPY.repeat.calendarDate}
							value={getOrdinalSuffix(dayOfMonth)}
							decreaseDisabled={dayOfMonth <= 1}
							increaseDisabled={dayOfMonth >= 31}
							onDecrease={() => onDayOfMonthChange(Math.max(1, dayOfMonth - 1))}
							onIncrease={() => onDayOfMonthChange(Math.min(31, dayOfMonth + 1))}
						/>
					</PickerSection>
				)}
			</AnimatePresence>
		</div>
	);
}
