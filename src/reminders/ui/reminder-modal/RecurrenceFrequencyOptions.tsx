import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import type { RecurrenceRule } from '../../types';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';
import type { GlassColors } from '../glassStyles';
import {
	RECURRENCE_DAY_LABELS,
	getOrdinalSuffix,
} from './recurrencePickerShared';

interface RecurrenceFrequencyOptionsProps {
	frequency: RecurrenceRule['frequency'];
	animationsEnabled: boolean;
	glass: GlassColors;
	interval: number;
	selectedDays: number[];
	dayOfMonth: number;
	onIntervalChange: (value: number) => void;
	onToggleDay: (dayIndex: number) => void;
	onDayOfMonthChange: (value: number) => void;
}

function StepperButton({
	disabled,
	glass,
	onClick,
	children,
}: {
	disabled?: boolean;
	glass: GlassColors;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<ShadowDOMNativeButton
			onClick={onClick}
			className="flex items-center justify-center w-9 h-9 rounded-lg active:scale-95"
			style={{
				background: glass.surfaceHover.bg,
				border: `1px solid ${glass.surface.border}`,
				color: glass.text.primary,
				fontSize: 16,
				fontWeight: 600,
				cursor: 'pointer',
				opacity: disabled ? 0.3 : 1,
			}}
		>
			{children}
		</ShadowDOMNativeButton>
	);
}

export function RecurrenceFrequencyOptions({
	frequency,
	animationsEnabled,
	glass,
	interval,
	selectedDays,
	dayOfMonth,
	onIntervalChange,
	onToggleDay,
	onDayOfMonthChange,
}: RecurrenceFrequencyOptionsProps) {
	return (
		<div style={{ minHeight: 90, marginTop: 16 }}>
			<AnimatePresence mode="wait">
				<motion.div
					key={frequency}
					initial={animationsEnabled ? { opacity: 0 } : false}
					animate={{ opacity: 1 }}
					exit={animationsEnabled ? { opacity: 0 } : undefined}
					transition={{ duration: 0.15 }}
					style={{
						minHeight: 90,
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'center',
					}}
				>
					{frequency === 'daily' && (
						<div
							className="flex items-center justify-center gap-3"
							style={{
								padding: '12px 16px',
								borderRadius: 12,
								background: glass.surface.bg,
								border: `1px solid ${glass.surface.border}`,
							}}
						>
							<span style={{ fontSize: 14, color: glass.text.secondary }}>
								Every
							</span>
							<div className="flex items-center gap-1">
								<StepperButton
									glass={glass}
									disabled={interval <= 1}
									onClick={() => onIntervalChange(Math.max(1, interval - 1))}
								>
									-
								</StepperButton>
								<span
									style={{
										minWidth: 32,
										textAlign: 'center',
										fontSize: 16,
										fontWeight: 700,
										color: glass.text.primary,
									}}
								>
									{interval}
								</span>
								<StepperButton
									glass={glass}
									onClick={() => onIntervalChange(Math.min(30, interval + 1))}
								>
									+
								</StepperButton>
							</div>
							<span style={{ fontSize: 14, color: glass.text.secondary }}>
								{interval === 1 ? 'day' : 'days'}
							</span>
						</div>
					)}

					{frequency === 'weekly' && (
						<div>
							<div style={{
								fontSize: 11,
								fontWeight: 500,
								color: glass.text.tertiary,
								textTransform: 'uppercase',
								letterSpacing: '0.04em',
								marginBottom: 10,
							}}>
								Repeat on
							</div>
							<div style={{ display: 'flex', gap: 6 }}>
								{RECURRENCE_DAY_LABELS.map((label, idx) => {
									const isSelected = selectedDays.includes(idx);
									return (
										<ShadowDOMNativeButton
											key={idx}
											onClick={() => onToggleDay(idx)}
											style={{
												flex: 1,
												aspectRatio: '1',
												maxWidth: 44,
												borderRadius: 12,
												border: 'none',
												background: isSelected ? glass.accent : glass.surface.bg,
												color: isSelected ? 'white' : glass.text.secondary,
												fontSize: 12,
												fontWeight: 600,
												cursor: 'pointer',
												transition: 'all 150ms ease',
											}}
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
							className="flex items-center justify-center gap-3"
							style={{
								padding: '12px 16px',
								borderRadius: 12,
								background: glass.surface.bg,
								border: `1px solid ${glass.surface.border}`,
							}}
						>
							<span style={{ fontSize: 14, color: glass.text.secondary }}>
								Day
							</span>
							<div className="flex items-center gap-1">
								<StepperButton
									glass={glass}
									disabled={dayOfMonth <= 1}
									onClick={() => onDayOfMonthChange(Math.max(1, dayOfMonth - 1))}
								>
									-
								</StepperButton>
								<span
									style={{
										minWidth: 40,
										textAlign: 'center',
										fontSize: 16,
										fontWeight: 700,
										color: glass.text.primary,
									}}
								>
									{getOrdinalSuffix(dayOfMonth)}
								</span>
								<StepperButton
									glass={glass}
									disabled={dayOfMonth >= 31}
									onClick={() => onDayOfMonthChange(Math.min(31, dayOfMonth + 1))}
								>
									+
								</StepperButton>
							</div>
							<span style={{ fontSize: 14, color: glass.text.secondary }}>
								of each month
							</span>
						</div>
					)}
				</motion.div>
			</AnimatePresence>
		</div>
	);
}
