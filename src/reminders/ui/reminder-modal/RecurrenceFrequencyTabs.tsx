import { motion } from 'framer-motion';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
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
	return (
		<div className="recurrence-frequency-tabs" role="tablist" aria-label="Repeat frequency">
			<motion.div
				layout
				transition={{ type: 'spring', stiffness: 400, damping: 30 }}
				className={`recurrence-frequency-indicator is-${frequency}`}
			/>
			{RECURRENCE_FREQUENCIES.map((freq) => {
				const isSelected = frequency === freq;
				return (
					<ShadowDOMNativeButton
						key={freq}
						onClick={() => onChange(freq)}
						role="tab"
						aria-selected={isSelected}
						className={`recurrence-frequency-button${isSelected ? ' is-selected' : ''}`}
					>
						{RECURRENCE_FREQUENCY_LABELS[freq]}
					</ShadowDOMNativeButton>
				);
			})}
		</div>
	);
}
