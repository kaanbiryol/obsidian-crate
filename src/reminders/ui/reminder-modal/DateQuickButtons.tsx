import React from 'react';
import { addDays, isSameDay, nextMonday } from 'date-fns';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';
import type { GlassColors } from '../glassStyles';

interface QuickDateOption {
	label: string;
	getDate: () => Date;
}

const QUICK_DATES: QuickDateOption[] = [
	{ label: 'Today', getDate: () => new Date() },
	{ label: 'Tomorrow', getDate: () => addDays(new Date(), 1) },
	{ label: 'Next Week', getDate: () => nextMonday(new Date()) },
];

interface DateQuickButtonsProps {
	currentDate: Date | null;
	glass: GlassColors;
	onSelectDate: (date: Date) => void;
}

export function DateQuickButtons({
	currentDate,
	glass,
	onSelectDate,
}: DateQuickButtonsProps) {
	return (
		<div className="flex gap-2 px-4 pb-3">
			{QUICK_DATES.map(({ label, getDate }) => {
				const optionDate = getDate();
				const isActive = currentDate && isSameDay(currentDate, optionDate);
				return (
					<ShadowDOMNativeButton
						key={label}
						onClick={() => onSelectDate(optionDate)}
						className="flex-1 h-9 rounded-xl transition-all duration-150 active:scale-95"
						style={{
							fontSize: '13px',
							fontWeight: 500,
							border: 'none',
							cursor: 'pointer',
							background: isActive ? glass.accent : glass.surface.bg,
							color: isActive ? 'white' : glass.text.secondary,
						}}
						onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
							if (!isActive) {
								e.currentTarget.style.background = glass.surfaceHover.bg;
							}
						}}
						onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
							if (!isActive) {
								e.currentTarget.style.background = glass.surface.bg;
							}
						}}
					>
						{label}
					</ShadowDOMNativeButton>
				);
			})}
		</div>
	);
}
