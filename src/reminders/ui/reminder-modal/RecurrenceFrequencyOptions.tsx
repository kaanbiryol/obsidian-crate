import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ObsidianIcon } from '../../components/obsidian-icon';
import {
	getRecurrenceDayLabels,
	getRecurrenceDayNames,
	getOrdinalSuffix,
} from './recurrencePickerShared';
import { REMINDER_PICKER_COPY } from './pickerCopy';

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

function StepperButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<ShadowDOMNativeButton
			onClick={onClick}
			aria-label={label}
			className="recurrence-stepper-button"
			disabled={disabled}
		>
			{children}
		</ShadowDOMNativeButton>
	);
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
		<div className="recurrence-option-row">
			<div className="recurrence-option-copy">
				<strong>{label}</strong>
				<span>{detail}</span>
			</div>
			<div className="recurrence-stepper">
				<StepperButton
					label={`Decrease ${label.toLowerCase()}`}
					disabled={decreaseDisabled}
					onClick={onDecrease}
				>
					<ObsidianIcon size="s" id="minus" />
				</StepperButton>
				<strong className="recurrence-stepper-value" aria-live="polite">{value}</strong>
				<StepperButton
					label={`Increase ${label.toLowerCase()}`}
					disabled={increaseDisabled}
					onClick={onIncrease}
				>
					<ObsidianIcon size="s" id="plus" />
				</StepperButton>
			</div>
		</div>
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
	return (
		<div className="recurrence-options">
			<AnimatePresence mode="wait">
				<motion.div
					key={frequency}
					initial={animationsEnabled ? { opacity: 0 } : false}
					animate={{ opacity: 1 }}
					exit={animationsEnabled ? { opacity: 0 } : undefined}
					transition={{ duration: 0.15 }}
					className="recurrence-options-panel"
					id="recurrence-options-panel"
					role="tabpanel"
					aria-labelledby={`recurrence-frequency-${frequency}`}
				>
					{frequency === 'daily' && (
						<StepperControl
							label={REMINDER_PICKER_COPY.repeat.every}
							detail={interval === 1 ? 'day' : 'days'}
							value={interval}
							decreaseDisabled={interval <= 1}
							onDecrease={() => onIntervalChange(Math.max(1, interval - 1))}
							onIncrease={() => onIntervalChange(Math.min(30, interval + 1))}
						/>
					)}

					{frequency === 'weekly' && (
						<div>
							<div className="recurrence-day-list">
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
						</div>
					)}

					{frequency === 'monthly' && (
						<StepperControl
							label={REMINDER_PICKER_COPY.repeat.dayOfMonth}
							detail={REMINDER_PICKER_COPY.repeat.calendarDate}
							value={getOrdinalSuffix(dayOfMonth)}
							decreaseDisabled={dayOfMonth <= 1}
							increaseDisabled={dayOfMonth >= 31}
							onDecrease={() => onDayOfMonthChange(Math.max(1, dayOfMonth - 1))}
							onIncrease={() => onDayOfMonthChange(Math.min(31, dayOfMonth + 1))}
						/>
					)}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}
