import { describe, expect, it, vi } from 'vitest';
import {
	buildRecurrencePickerDraft,
	getOrdinalSuffix,
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
		})).toBe('Every 3 days at 08:15');
		expect(summarizeRecurrencePickerState({
			frequency: 'weekly',
			interval: 1,
			daysOfWeek: [1, 3],
			dayOfMonth: 1,
			hour: 8,
			minute: 15,
		})).toBe('Mon, Wed at 08:15');
		expect(getOrdinalSuffix(21)).toBe('21st');
	});
});
