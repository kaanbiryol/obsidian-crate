import { CalendarDate } from '@internationalized/date';
import { getLocaleWeekStart, getUiLocale } from '../../utils/uiLocale';

export { getLocaleWeekStart, getUiLocale } from '../../utils/uiLocale';

export function getLocalizedWeekdays(locale = getUiLocale(), weekStart = getLocaleWeekStart(locale)) {
	const shortFormatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
	const longFormatter = new Intl.DateTimeFormat(locale, { weekday: 'long' });
	const sunday = new Date(2021, 7, 1);

	return Array.from({ length: 7 }, (_, offset) => {
		const weekday = (weekStart + offset) % 7;
		const date = new Date(sunday);
		date.setDate(sunday.getDate() + weekday);
		return {
			weekday,
			short: shortFormatter.format(date),
			long: longFormatter.format(date),
		};
	});
}

export function buildCalendarGrid(displayMonth: CalendarDate, weekStart: number): Date[] {
	const firstWeekday = new Date(displayMonth.year, displayMonth.month - 1, 1).getDay();
	const leadingDays = (firstWeekday - weekStart + 7) % 7;
	return Array.from({ length: 42 }, (_, index) => (
		new Date(displayMonth.year, displayMonth.month - 1, index - leadingDays + 1)
	));
}

export function addCalendarDays(date: Date, amount: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + amount);
	return result;
}

export function addCalendarMonths(date: Date, amount: number): Date {
	const targetMonth = date.getMonth() + amount;
	const result = new Date(date.getFullYear(), targetMonth, 1);
	const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
	result.setDate(Math.min(date.getDate(), lastDay));
	return result;
}

export function isSameLocalDay(left: Date, right: Date): boolean {
	return left.getFullYear() === right.getFullYear()
		&& left.getMonth() === right.getMonth()
		&& left.getDate() === right.getDate();
}

export function isInDisplayMonth(date: Date, displayMonth: CalendarDate): boolean {
	return date.getFullYear() === displayMonth.year
		&& date.getMonth() === displayMonth.month - 1;
}

export function calendarDateKey(date: Date): string {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
