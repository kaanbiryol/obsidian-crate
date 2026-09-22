import { describe, expect, it, vi } from 'vitest';
import {
	buildRecurrencePickerDraft,
	buildRecurrencePickerState,
	getOrdinalSuffix,
	isRecurrencePickerStateUnchanged,
	recurrenceRuleFromPickerDraft,
	summarizeRecurrencePickerState,
} from './recurrencePickerShared';
import { timezone as getLocalTimeZone } from '../../utils/time';

describe('recurrencePickerShared', () => {
	it('builds picker drafts from existing recurrence rules', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 3, 18, 10, 0));

		expect(buildRecurrencePickerDraft({
			frequency: 'weekly',
			interval: 2,
			daysOfWeek: [1, 3],
			hour: 7,
			minute: 5,
		})).toEqual({
			frequency: 'weekly',
			interval: 2,
			daysOfWeek: [1, 3],
			dayOfMonth: 18,
			time: '07:05',
		});

		vi.useRealTimers();
	});

	it('converts picker drafts into normalized recurrence rules', () => {
		const rule = recurrenceRuleFromPickerDraft({
			frequency: 'monthly',
			interval: 1,
			daysOfWeek: [],
			dayOfMonth: 40,
			time: '30:99',
		});

		expect(rule).toEqual({
			frequency: 'monthly',
			dayOfMonth: 31,
			hour: 23,
			minute: 59,
			timezone: getLocalTimeZone(),
		});
	});

	it('summarizes recurrence picker state in user-facing labels', () => {
		expect(summarizeRecurrencePickerState({
			frequency: 'daily',
			interval: 3,
			daysOfWeek: [],
			dayOfMonth: 1,
			hour: 8,
			minute: 15,
		}, 'en-GB')).toBe('Every 3 days at 08:15');
		expect(summarizeRecurrencePickerState({
			frequency: 'weekly',
			interval: 1,
			daysOfWeek: [1, 3],
			dayOfMonth: 1,
			hour: 8,
			minute: 15,
		}, 'en-GB')).toBe('Weekly on Mon, Wed at 08:15');
		expect(summarizeRecurrencePickerState({
			frequency: 'monthly',
			interval: 2,
			daysOfWeek: [],
			dayOfMonth: 21,
			hour: 8,
			minute: 15,
		}, 'en-GB')).toBe('Every 2 months on the 21st at 08:15');
		expect(getOrdinalSuffix(21)).toBe('21st');
	});

	it('treats reverted weekday selection and inactive controls as unchanged', () => {
		const initial = buildRecurrencePickerState({ frequency: 'weekly', daysOfWeek: [3, 1], hour: 9, minute: 0 });
		expect(isRecurrencePickerStateUnchanged({ ...initial, daysOfWeek: [1, 3], dayOfMonth: 31 }, initial)).toBe(true);
		expect(initial.daysOfWeek).toEqual([3, 1]);
	});

	it('compares the displayed defaults without requiring an all-day rule to gain a time', () => {
		const initial = buildRecurrencePickerState({ frequency: 'monthly' }, 1);
		expect(initial).toMatchObject({ interval: 1, dayOfMonth: 1, hour: 9, minute: 0 });
		expect(isRecurrencePickerStateUnchanged({ ...initial }, initial)).toBe(true);
		expect(isRecurrencePickerStateUnchanged({ ...initial, dayOfMonth: 2 }, initial)).toBe(false);
	});

	it.each([
		{ frequency: 'daily' as const }, { interval: 2 }, { daysOfWeek: [1, 5] }, { hour: 10 }, { minute: 30 },
	])('detects an actual repeat edit: %j', patch => {
		const initial = buildRecurrencePickerState({ frequency: 'weekly', daysOfWeek: [1, 3], hour: 9, minute: 0 });
		expect(isRecurrencePickerStateUnchanged({ ...initial, ...patch }, initial)).toBe(false);
	});

	it('ignores weekday and month-day controls after returning to daily', () => {
		const initial = buildRecurrencePickerState({ frequency: 'daily' });
		expect(isRecurrencePickerStateUnchanged({ ...initial, daysOfWeek: [1], dayOfMonth: 31 }, initial)).toBe(true);
	});
});

it('keeps typed seconds when changing only the repeat interval', () => {
    const original = { frequency: 'daily' as const, hour: 9, minute: 0, second: 30, millisecond: 123, timezone: 'UTC' };
    const draft = buildRecurrencePickerDraft(original);
    const changed = recurrenceRuleFromPickerDraft({ ...draft, interval: 2 }, original.timezone);
    expect(changed).toEqual({ ...original, interval: 2 });
    const initial = buildRecurrencePickerState(original);
    expect(isRecurrencePickerStateUnchanged({ ...initial, second: undefined, millisecond: undefined }, initial)).toBe(false);
});
