import React from 'react';
import { Calendar } from '@heroui/react';
import { CalendarDate, parseDate } from '@internationalized/date';
import { format } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';
import { formatLocalDateKey } from '../../utils/reminderDate';
import type { GlassColors } from '../glassStyles';

const calendarVariants = {
	enter: (direction: number) => ({
		x: direction > 0 ? 20 : -20,
		opacity: 0,
	}),
	center: {
		x: 0,
		opacity: 1,
		transition: {
			x: { duration: 0.2, ease: [0.2, 0, 0, 1] as const },
			opacity: { duration: 0.15 },
		},
	},
	exit: (direction: number) => ({
		x: direction < 0 ? 20 : -20,
		opacity: 0,
		transition: {
			x: { duration: 0.15, ease: [0.2, 0, 0, 1] as const },
			opacity: { duration: 0.1 },
		},
	}),
};

interface DateCalendarPanelProps {
	currentDate: Date | null;
	displayMonth: CalendarDate;
	calendarDirection: number;
	animationsEnabled: boolean;
	glass: GlassColors;
	isDark: boolean;
	onPrevMonth: () => void;
	onNextMonth: () => void;
	onDateChange: (date: CalendarDate) => void;
}

export function DateCalendarPanel({
	currentDate,
	displayMonth,
	calendarDirection,
	animationsEnabled,
	glass,
	isDark,
	onPrevMonth,
	onNextMonth,
	onDateChange,
}: DateCalendarPanelProps) {
	return (
		<div className="px-4 pt-2">
			<div className="flex items-center justify-center gap-4 mb-3">
				<ShadowDOMNativeButton
					onClick={onPrevMonth}
					className="flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 active:scale-95"
					style={{
						background: glass.surface.bg,
						border: `1px solid ${glass.surface.border}`,
						cursor: 'pointer',
						padding: 0,
					}}
					onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
						e.currentTarget.style.background = glass.surfaceHover.bg;
						e.currentTarget.style.borderColor = glass.surfaceHover.border;
					}}
					onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
						e.currentTarget.style.background = glass.surface.bg;
						e.currentTarget.style.borderColor = glass.surface.border;
					}}
				>
					<ChevronLeft
						size={18}
						strokeWidth={2}
						style={{ color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)' }}
					/>
				</ShadowDOMNativeButton>

				<span
					style={{
						fontSize: '16px',
						fontWeight: 600,
						color: 'var(--text-normal)',
						letterSpacing: '-0.01em',
						minWidth: '140px',
						textAlign: 'center',
					}}
				>
					{format(new Date(displayMonth.year, displayMonth.month - 1), 'MMMM yyyy')}
				</span>

				<ShadowDOMNativeButton
					onClick={onNextMonth}
					className="flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 active:scale-95"
					style={{
						background: glass.surface.bg,
						border: `1px solid ${glass.surface.border}`,
						cursor: 'pointer',
						padding: 0,
					}}
					onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
						e.currentTarget.style.background = glass.surfaceHover.bg;
						e.currentTarget.style.borderColor = glass.surfaceHover.border;
					}}
					onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
						e.currentTarget.style.background = glass.surface.bg;
						e.currentTarget.style.borderColor = glass.surface.border;
					}}
				>
					<ChevronRight
						size={18}
						strokeWidth={2}
						style={{ color: isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)' }}
					/>
				</ShadowDOMNativeButton>
			</div>

			<div style={{ minHeight: '280px' }}>
				<AnimatePresence mode="wait" custom={calendarDirection}>
					<motion.div
						key={`${displayMonth.year}-${displayMonth.month}`}
						custom={calendarDirection}
						variants={animationsEnabled ? calendarVariants : undefined}
						initial={animationsEnabled ? "enter" : false}
						animate="center"
						exit={animationsEnabled ? "exit" : undefined}
						className="flex justify-center"
					>
						<Calendar
							aria-label="Date picker"
							showShadow={false}
							value={currentDate ? parseDate(formatLocalDateKey(currentDate)) : undefined}
							defaultFocusedValue={displayMonth}
							focusedValue={displayMonth}
							onChange={(date) => {
								if (date) {
									onDateChange(date);
								}
							}}
							classNames={{
								base: '!bg-transparent !shadow-none !border-none w-full max-w-[320px]',
								content: '!bg-transparent !shadow-none !border-none w-full',
								headerWrapper: 'hidden',
								gridWrapper: 'pb-0 w-full !border-none',
								grid: 'gap-0 w-full !border-none',
								gridBody: '!border-none',
								gridHeader: 'pb-2 !border-none',
								gridHeaderRow: '!border-none',
								gridHeaderCell: 'w-10 h-8 text-[11px] font-semibold text-[var(--text-faint)] uppercase tracking-wider !border-none',
								cell: 'w-10 h-10 flex items-center justify-center !border-none',
								cellButton: [
									'w-8 h-8 text-[13px] font-medium rounded-full',
									'transition-transform duration-150',
									'!border-none !outline-none',
									'data-[selected=true]:bg-[hsl(var(--heroui-primary))]',
									'data-[selected=true]:text-white data-[selected=true]:font-semibold',
									'data-[selected=true]:shadow-[0_0_12px_hsl(var(--heroui-primary)/0.5)]',
									'data-[today=true]:font-bold data-[today=true]:text-[var(--interactive-accent)]',
									'data-[today=true]:shadow-[0_0_8px_var(--interactive-accent)/0.3]',
									'data-[outside-month=true]:text-[var(--text-faint)] data-[outside-month=true]:opacity-25',
									'hover:bg-[var(--background-modifier-hover)] active:scale-95',
								].join(' '),
							}}
						/>
					</motion.div>
				</AnimatePresence>
			</div>
		</div>
	);
}
