import { CalendarDate } from '@internationalized/date';
import { describe, expect, it } from 'vitest';
import {
	addCalendarMonths,
	buildCalendarGrid,
	getLocalizedWeekdays,
} from './calendarLocalization';

describe('calendar localization helpers', () => {
	it('aligns the calendar grid with the locale week start', () => {
		const month = new CalendarDate(2026, 9, 1);
		const sundayGrid = buildCalendarGrid(month, 0);
		const mondayGrid = buildCalendarGrid(month, 1);

		expect(sundayGrid[0]).toEqual(new Date(2026, 7, 30));
		expect(mondayGrid[0]).toEqual(new Date(2026, 7, 31));
	});

	it('provides localized weekday headings in display order', () => {
		const weekdays = getLocalizedWeekdays('de-DE', 1);

		expect(weekdays[0]).toMatchObject({ weekday: 1, long: 'Montag' });
		expect(weekdays[6]).toMatchObject({ weekday: 0, long: 'Sonntag' });
	});

	it('clamps month keyboard navigation to the last valid day', () => {
		expect(addCalendarMonths(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 28));
	});
});
