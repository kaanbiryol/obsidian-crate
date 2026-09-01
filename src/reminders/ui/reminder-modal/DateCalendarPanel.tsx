import { CalendarDate } from '@internationalized/date';
import { format } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function calendarGrid(displayMonth: CalendarDate): Date[] {
	const firstWeekday = new Date(displayMonth.year, displayMonth.month - 1, 1).getDay();
	return Array.from({ length: 42 }, (_, index) => (
		new Date(displayMonth.year, displayMonth.month - 1, index - firstWeekday + 1)
	));
}

function isSameLocalDay(left: Date, right: Date): boolean {
	return left.getFullYear() === right.getFullYear()
		&& left.getMonth() === right.getMonth()
		&& left.getDate() === right.getDate();
}

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
	const days = calendarGrid(displayMonth);
	const today = new Date();

	return (
		<div className="date-calendar-panel px-4 pt-2">
			<div className="flex items-center justify-center gap-4 mb-3">
				<ShadowDOMNativeButton
					onClick={onPrevMonth}
					aria-label="Previous month"
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
					aria-label="Next month"
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
						<table className="date-calendar-grid" aria-label="Date picker">
							<thead>
								<tr>
									{WEEKDAYS.map(weekday => <th key={weekday} scope="col">{weekday}</th>)}
								</tr>
							</thead>
							<tbody>
								{Array.from({ length: 6 }, (_, weekIndex) => (
									<tr key={weekIndex}>
										{days.slice(weekIndex * 7, weekIndex * 7 + 7).map(date => {
											const selected = currentDate ? isSameLocalDay(date, currentDate) : false;
											const isToday = isSameLocalDay(date, today);
											const outsideMonth = date.getMonth() !== displayMonth.month - 1;
											const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
											return (
												<td key={key}>
													<button
														type="button"
														aria-label={format(date, 'MMMM d, yyyy')}
														aria-current={isToday ? 'date' : undefined}
														aria-pressed={selected}
														data-outside-month={outsideMonth || undefined}
														data-selected={selected || undefined}
														data-today={isToday || undefined}
														onClick={() => onDateChange(new CalendarDate(
															date.getFullYear(),
															date.getMonth() + 1,
															date.getDate(),
														))}
													>
														{date.getDate()}
													</button>
												</td>
											);
										})}
									</tr>
								))}
							</tbody>
						</table>
					</motion.div>
				</AnimatePresence>
			</div>
		</div>
	);
}
