import { CalendarDate } from '@internationalized/date';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ObsidianIcon } from '../../components/obsidian-icon';
import {
	addCalendarDays,
	addCalendarMonths,
	buildCalendarGrid,
	calendarDateKey,
	getLocaleWeekStart,
	getLocalizedWeekdays,
	getUiLocale,
	isInDisplayMonth,
	isSameLocalDay,
} from './calendarLocalization';

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
	const locale = useMemo(getUiLocale, []);
	const weekStart = useMemo(() => getLocaleWeekStart(locale), [locale]);
	const weekdays = useMemo(() => getLocalizedWeekdays(locale, weekStart), [locale, weekStart]);
	const days = useMemo(() => buildCalendarGrid(displayMonth, weekStart), [displayMonth, weekStart]);
	const today = new Date();
	const [focusedDate, setFocusedDate] = useState(() => currentDate ?? today);
	const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
	const restoreGridFocusRef = useRef(false);
	const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
	}), [locale]);
	const dateLabelFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	}), [locale]);

	useEffect(() => {
		if (restoreGridFocusRef.current) return;
		if (currentDate && isInDisplayMonth(currentDate, displayMonth)) {
			if (!isSameLocalDay(currentDate, focusedDate)) {
				setFocusedDate(currentDate);
			}
			return;
		}

		if (!isInDisplayMonth(focusedDate, displayMonth)) {
			const lastDay = new Date(displayMonth.year, displayMonth.month, 0).getDate();
			setFocusedDate(new Date(
				displayMonth.year,
				displayMonth.month - 1,
				Math.min(focusedDate.getDate(), lastDay),
			));
		}
	}, [currentDate, displayMonth, focusedDate]);

	useLayoutEffect(() => {
		if (!restoreGridFocusRef.current) return;
		const target = buttonRefs.current.get(calendarDateKey(focusedDate));
		if (!target) return;
		restoreGridFocusRef.current = false;
		target.focus();
	}, [displayMonth, focusedDate]);

	const moveFocus = (targetDate: Date) => {
		restoreGridFocusRef.current = true;
		setFocusedDate(targetDate);
		if (targetDate.getFullYear() < displayMonth.year
			|| (targetDate.getFullYear() === displayMonth.year && targetDate.getMonth() < displayMonth.month - 1)) {
			onPrevMonth();
		} else if (targetDate.getFullYear() > displayMonth.year
			|| (targetDate.getFullYear() === displayMonth.year && targetDate.getMonth() > displayMonth.month - 1)) {
			onNextMonth();
		}
	};

	const handleDateKeyDown = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
		const isRtl = typeof document !== 'undefined' && document.dir === 'rtl';
		let targetDate: Date | null = null;
		switch (event.key) {
			case 'ArrowLeft':
				targetDate = addCalendarDays(date, isRtl ? 1 : -1);
				break;
			case 'ArrowRight':
				targetDate = addCalendarDays(date, isRtl ? -1 : 1);
				break;
			case 'ArrowUp':
				targetDate = addCalendarDays(date, -7);
				break;
			case 'ArrowDown':
				targetDate = addCalendarDays(date, 7);
				break;
			case 'Home':
				targetDate = addCalendarDays(date, -((date.getDay() - weekStart + 7) % 7));
				break;
			case 'End':
				targetDate = addCalendarDays(date, 6 - ((date.getDay() - weekStart + 7) % 7));
				break;
			case 'PageUp':
				targetDate = addCalendarMonths(date, -1);
				break;
			case 'PageDown':
				targetDate = addCalendarMonths(date, 1);
				break;
			default:
				return;
		}

		event.preventDefault();
		moveFocus(targetDate);
	};

	return (
		<div className="date-calendar-panel px-4 pt-2">
			<div className="flex items-center justify-center gap-4 mb-3">
				<ShadowDOMNativeButton
					onClick={onPrevMonth}
					aria-label="Previous month"
					className="date-calendar-navigation-button"
				>
					<ObsidianIcon size="m" id="chevron-left" />
				</ShadowDOMNativeButton>

				<span className="date-calendar-title">
					{monthFormatter.format(new Date(displayMonth.year, displayMonth.month - 1))}
				</span>

				<ShadowDOMNativeButton
					onClick={onNextMonth}
					aria-label="Next month"
					className="date-calendar-navigation-button"
				>
					<ObsidianIcon size="m" id="chevron-right" />
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
									{weekdays.map(({ weekday, short, long }) => (
										<th key={weekday} scope="col" aria-label={long}>{short}</th>
									))}
								</tr>
							</thead>
							<tbody>
								{Array.from({ length: 6 }, (_, weekIndex) => (
									<tr key={weekIndex}>
										{days.slice(weekIndex * 7, weekIndex * 7 + 7).map(date => {
											const selected = currentDate ? isSameLocalDay(date, currentDate) : false;
											const isToday = isSameLocalDay(date, today);
											const outsideMonth = date.getMonth() !== displayMonth.month - 1;
											const key = calendarDateKey(date);
											return (
												<td key={key}>
													<button
														ref={(element) => {
															if (element) buttonRefs.current.set(key, element);
															else buttonRefs.current.delete(key);
														}}
														type="button"
														aria-label={dateLabelFormatter.format(date)}
														aria-current={isToday ? 'date' : undefined}
														aria-pressed={selected}
														tabIndex={isSameLocalDay(date, focusedDate) ? 0 : -1}
														data-outside-month={outsideMonth || undefined}
														data-selected={selected || undefined}
														data-today={isToday || undefined}
														onFocus={() => setFocusedDate(date)}
														onKeyDown={(event) => handleDateKeyDown(event, date)}
														onClick={() => {
															setFocusedDate(date);
															onDateChange(new CalendarDate(
																date.getFullYear(),
																date.getMonth() + 1,
																date.getDate(),
															));
														}}
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
