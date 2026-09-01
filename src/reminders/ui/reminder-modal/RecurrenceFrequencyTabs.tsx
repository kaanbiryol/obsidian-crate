import { motion } from 'framer-motion';
import { useRef, type KeyboardEvent } from 'react';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import {
	RECURRENCE_FREQUENCIES,
	RECURRENCE_FREQUENCY_LABELS,
} from './recurrencePickerShared';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

interface RecurrenceFrequencyTabsProps {
	frequency: RecurrenceRule['frequency'];
	onChange: (frequency: RecurrenceRule['frequency']) => void;
}

export function RecurrenceFrequencyTabs({
	frequency,
	onChange,
}: RecurrenceFrequencyTabsProps) {
	const reduceMotion = useObsidianReducedMotion();
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
			<motion.div
				layout={!reduceMotion}
				transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
				className={`recurrence-frequency-indicator is-${frequency}`}
				aria-hidden="true"
			/>
			{RECURRENCE_FREQUENCIES.map((freq, index) => {
				const isSelected = frequency === freq;
				return (
					<ShadowDOMNativeButton
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
					</ShadowDOMNativeButton>
				);
			})}
		</div>
	);
}
