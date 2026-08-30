import { Calendar } from '@heroui/react';
import { CalendarDate, parseDate } from '@internationalized/date';
import { format } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { formatLocalDateKey } from '../../utils/reminderDate';

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
	onPrevMonth: () => void;
	onNextMonth: () => void;
	onDateChange: (date: CalendarDate) => void;
}

export function DateCalendarPanel({
	currentDate,
	displayMonth,
	calendarDirection,
	animationsEnabled,
	onPrevMonth,
	onNextMonth,
	onDateChange,
}: DateCalendarPanelProps) {
	return (
		<div className="px-4 pt-2">
			<div className="flex items-center justify-center gap-4 mb-3">
				<ShadowDOMNativeButton
					onClick={onPrevMonth}
					className="date-calendar-navigation-button flex items-center justify-center w-9 h-9 rounded-xl active:scale-95"
				>
					<ChevronLeft
						size={18}
						strokeWidth={2}
					/>
				</ShadowDOMNativeButton>

				<span className="date-calendar-title">
					{format(new Date(displayMonth.year, displayMonth.month - 1), 'MMMM yyyy')}
				</span>

				<ShadowDOMNativeButton
					onClick={onNextMonth}
					className="date-calendar-navigation-button flex items-center justify-center w-9 h-9 rounded-xl active:scale-95"
				>
					<ChevronRight
						size={18}
						strokeWidth={2}
					/>
				</ShadowDOMNativeButton>
			</div>

			<div className="date-calendar-stage">
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
									'data-[selected=true]:bg-[var(--interactive-accent)]',
									'data-[selected=true]:text-[var(--text-on-accent)] data-[selected=true]:font-semibold',
									'data-[selected=true]:shadow-[0_0_12px_color-mix(in_srgb,var(--interactive-accent)_50%,transparent)]',
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
