import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';
import {
	RECURRENCE_DAY_LABELS,
	getOrdinalSuffix,
} from './recurrencePickerShared';

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
	disabled,
	onClick,
	children,
}: {
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<ShadowDOMNativeButton
			onClick={onClick}
			className="recurrence-stepper-button flex items-center justify-center w-9 h-9 rounded-lg active:scale-95"
			disabled={disabled}
		>
			{children}
		</ShadowDOMNativeButton>
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
						<div
							className="recurrence-option-row"
						>
							<span className="recurrence-option-label">
								Every
							</span>
							<div className="flex items-center gap-1">
								<StepperButton
									disabled={interval <= 1}
									onClick={() => onIntervalChange(Math.max(1, interval - 1))}
								>
									-
								</StepperButton>
								<span
									className="recurrence-stepper-value"
								>
									{interval}
								</span>
								<StepperButton
									onClick={() => onIntervalChange(Math.min(30, interval + 1))}
								>
									+
								</StepperButton>
							</div>
							<span className="recurrence-option-label">
								{interval === 1 ? 'day' : 'days'}
							</span>
						</div>
					)}

					{frequency === 'weekly' && (
						<div>
							<div className="recurrence-option-heading">
								Repeat on
							</div>
							<div className="recurrence-day-list">
								{RECURRENCE_DAY_LABELS.map((label, idx) => {
									const isSelected = selectedDays.includes(idx);
									return (
										<ShadowDOMNativeButton
											key={idx}
											onClick={() => onToggleDay(idx)}
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
						<div
							className="recurrence-option-row"
						>
							<span className="recurrence-option-label">
								Day
							</span>
							<div className="flex items-center gap-1">
								<StepperButton
									disabled={dayOfMonth <= 1}
									onClick={() => onDayOfMonthChange(Math.max(1, dayOfMonth - 1))}
								>
									-
								</StepperButton>
								<span
									className="recurrence-stepper-value is-ordinal"
								>
									{getOrdinalSuffix(dayOfMonth)}
								</span>
								<StepperButton
									disabled={dayOfMonth >= 31}
									onClick={() => onDayOfMonthChange(Math.min(31, dayOfMonth + 1))}
								>
									+
								</StepperButton>
							</div>
							<span className="recurrence-option-label">
								of each month
							</span>
						</div>
					)}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}
