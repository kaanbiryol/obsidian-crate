import { motion } from 'framer-motion';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';
import type { GlassColors } from '../glassStyles';
import {
	RECURRENCE_FREQUENCIES,
	RECURRENCE_FREQUENCY_LABELS,
} from './recurrencePickerShared';

interface RecurrenceFrequencyTabsProps {
	frequency: RecurrenceRule['frequency'];
	glass: GlassColors;
	isDark: boolean;
	onChange: (frequency: RecurrenceRule['frequency']) => void;
}

export function RecurrenceFrequencyTabs({
	frequency,
	glass,
	isDark,
	onChange,
}: RecurrenceFrequencyTabsProps) {
	const frequencyIndex = RECURRENCE_FREQUENCIES.indexOf(frequency);

	return (
		<div
			className="relative"
			style={{
				display: 'flex',
				padding: 4,
				borderRadius: 14,
				background: glass.surface.bg,
				border: `1px solid ${glass.surface.border}`,
			}}
		>
			<motion.div
				layout
				transition={{ type: 'spring', stiffness: 400, damping: 30 }}
				style={{
					position: 'absolute',
					top: 4,
					bottom: 4,
					left: `calc(${frequencyIndex * (100 / 3)}% + 4px)`,
					width: `calc(${100 / 3}% - 8px)`,
					borderRadius: 10,
					background: glass.accent,
					boxShadow: isDark
						? '0 2px 8px hsl(var(--heroui-primary) / 0.3)'
						: '0 2px 8px hsl(var(--heroui-primary) / 0.2)',
				}}
			/>
			{RECURRENCE_FREQUENCIES.map((freq) => {
				const isSelected = frequency === freq;
				return (
					<ShadowDOMNativeButton
						key={freq}
						onClick={() => onChange(freq)}
						style={{
							flex: 1,
							height: 36,
							borderRadius: 10,
							border: 'none',
							background: 'transparent',
							color: isSelected ? 'white' : glass.text.secondary,
							fontSize: 13,
							fontWeight: isSelected ? 600 : 500,
							cursor: 'pointer',
							position: 'relative',
							zIndex: 1,
							transition: 'color 150ms ease',
						}}
					>
						{RECURRENCE_FREQUENCY_LABELS[freq]}
					</ShadowDOMNativeButton>
				);
			})}
		</div>
	);
}
