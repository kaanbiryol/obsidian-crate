import { AnimatePresence, motion } from 'framer-motion';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { RecurrenceRule } from '../../types';
import { Button } from '../../../ui/shared/Button';
import { IconButton } from '../../../ui/shared/IconButton';
import {
	getRecurrenceDayLabels,
	getRecurrenceDayNames,
} from './recurrencePickerShared';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { PickerFieldRow } from './PickerFieldRow';

const FREQUENCY_UNITS: Record<RecurrenceRule['frequency'], string> = {
	daily: 'day',
	weekly: 'week',
	monthly: 'month',
};

interface RecurrenceFrequencyOptionsProps {
	frequency: RecurrenceRule['frequency'];
	animationsEnabled: boolean;
	interval: number;
	timeControl: ReactNode;
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
	detail?: string;
	value: ReactNode;
	onDecrease: () => void;
	onIncrease: () => void;
	decreaseDisabled?: boolean;
	increaseDisabled?: boolean;
}) {
	return (
		<PickerFieldRow
			label={label}
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
				<strong className="recurrence-stepper-value" aria-live="polite">{value}{detail && <small> {detail}</small>}</strong>
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
	timeControl,
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
	const detailContentRef = useRef<HTMLDivElement>(null);
	const [detailHeight, setDetailHeight] = useState<number>();
	useLayoutEffect(() => {
		const content = detailContentRef.current;
		if (frequency === 'daily' || !content) return;
		const updateHeight = () => setDetailHeight(content.getBoundingClientRect().height);
		updateHeight();
		const observer = new ResizeObserver(updateHeight);
		observer.observe(content);
		return () => observer.disconnect();
	}, [frequency]);

	return (
		<div
			className="recurrence-options"
			id="recurrence-options-panel"
			role="tabpanel"
			aria-labelledby={`recurrence-frequency-${frequency}`}
			tabIndex={-1}
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

			{timeControl}
			<AnimatePresence initial={false}>
				{frequency !== 'daily' && (
					<motion.div
						key="frequency-detail"
						className="recurrence-frequency-detail"
						initial={animationsEnabled ? { height: 0, opacity: 0 } : false}
						animate={{ height: animationsEnabled ? detailHeight ?? 'auto' : 'auto', opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: animationsEnabled ? 0.16 : 0 }}
					>
						<div ref={detailContentRef} className="recurrence-frequency-detail-content">
							{frequency === 'weekly' && (
								<div>
									<div className="recurrence-day-list" role="group" aria-label="Repeat days">
										{dayLabels.map((label, idx) => {
											const isSelected = selectedDays.includes(idx);
											return (
												<Button
													key={idx}
													onClick={() => onToggleDay(idx)}
													aria-label={dayNames[idx]}
													aria-pressed={isSelected}
													className={`recurrence-day-button${isSelected ? ' is-selected' : ''}`}
												>
													{label}
												</Button>
											);
										})}
									</div>
								</div>
							)}

							{frequency === 'monthly' && (
								<div>
									<StepperControl
										label={REMINDER_PICKER_COPY.repeat.dayOfMonth}
										value={dayOfMonth}
										decreaseDisabled={dayOfMonth <= 1}
										increaseDisabled={dayOfMonth >= 31}
										onDecrease={() => onDayOfMonthChange(Math.max(1, dayOfMonth - 1))}
										onIncrease={() => onDayOfMonthChange(Math.min(31, dayOfMonth + 1))}
									/>
								</div>
							)}
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
