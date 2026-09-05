import { useRef, type KeyboardEvent } from 'react';
import type { RecurrenceRule } from '../../types';
import { Button } from '../../../ui/shared/Button';
import {
	RECURRENCE_FREQUENCIES,
	RECURRENCE_FREQUENCY_LABELS,
} from './recurrencePickerShared';

interface RecurrenceFrequencyTabsProps {
	frequency: RecurrenceRule['frequency'];
	onChange: (frequency: RecurrenceRule['frequency']) => void;
}

export function RecurrenceFrequencyTabs({
	frequency,
	onChange,
}: RecurrenceFrequencyTabsProps) {
	const tabRefs = useRef(new Map<RecurrenceRule['frequency'], HTMLButtonElement>());

	const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
		const isRtl = typeof document !== 'undefined' && document.dir === 'rtl';
		let nextIndex: number | null = null;
		if (event.key === 'ArrowRight') nextIndex = currentIndex + (isRtl ? -1 : 1);
		if (event.key === 'ArrowLeft') nextIndex = currentIndex + (isRtl ? 1 : -1);
		if (event.key === 'ArrowDown') nextIndex = currentIndex + 1;
		if (event.key === 'ArrowUp') nextIndex = currentIndex - 1;
		if (event.key === 'Home') nextIndex = 0;
		if (event.key === 'End') nextIndex = RECURRENCE_FREQUENCIES.length - 1;
		if (nextIndex === null) return;

		event.preventDefault();
		const nextFrequency = RECURRENCE_FREQUENCIES[
			(nextIndex + RECURRENCE_FREQUENCIES.length) % RECURRENCE_FREQUENCIES.length
		]!;
		onChange(nextFrequency);
		tabRefs.current.get(nextFrequency)?.focus();
	};

	return (
		<div className="recurrence-frequency-tabs" role="tablist" aria-label="Repeat frequency">
			{RECURRENCE_FREQUENCIES.map((freq, index) => {
				const isSelected = frequency === freq;
				return (
					<Button
						key={freq}
						ref={(element) => {
							if (element) tabRefs.current.set(freq, element);
							else tabRefs.current.delete(freq);
						}}
						onClick={() => onChange(freq)}
						onKeyDown={(event) => handleKeyDown(event, index)}
						role="tab"
						aria-selected={isSelected}
						aria-controls="recurrence-options-panel"
						id={`recurrence-frequency-${freq}`}
						tabIndex={isSelected ? 0 : -1}
						className={`recurrence-frequency-button${isSelected ? ' is-selected' : ''}`}
					>
						{RECURRENCE_FREQUENCY_LABELS[freq]}
					</Button>
				);
			})}
		</div>
	);
}
