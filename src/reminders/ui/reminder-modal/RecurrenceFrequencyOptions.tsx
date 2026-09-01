import { AnimatePresence, motion } from 'framer-motion';
import { Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import {
	RECURRENCE_DAY_LABELS,
	getOrdinalSuffix,
} from './recurrencePickerShared';
import { REMINDER_PICKER_COPY } from './pickerCopy';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

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
			className="recurrence-stepper-button flex items-center justify-center w-9 h-9 rounded-lg active:scale-95"
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
					<Minus size={16} />
				</StepperButton>
				<strong className="recurrence-stepper-value" aria-live="polite">{value}</strong>
				<StepperButton
					label={`Increase ${label.toLowerCase()}`}
					disabled={increaseDisabled}
					onClick={onIncrease}
				>
					<Plus size={16} />
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
								{RECURRENCE_DAY_LABELS.map((label, idx) => {
									const isSelected = selectedDays.includes(idx);
									return (
										<ShadowDOMNativeButton
											key={idx}
											onClick={() => onToggleDay(idx)}
											aria-label={DAY_NAMES[idx]}
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
