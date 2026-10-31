import fc from 'fast-check';
import { fromDate, getDayOfWeek } from '@internationalized/date';
import { describe, expect, it } from 'vitest';
import type { RecurrenceRule } from '../../types/reminder';
import { calculateNextOccurrence } from './recurrenceCalculator';
import { appendRecurrenceMetadata, readRecurrenceMetadata } from './recurrenceMetadata';
import { parseRecurrenceFromContent } from './recurrenceParser';
import { normalizeRecurrenceRule } from './recurrenceRule';
import { recurrenceToText } from './recurrenceText';
import { validateRecurrence } from './validateRecurrence';

// Zones with and without daylight saving, including a 30 minute shift and a large offset.
const zone = fc.constantFrom('UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Kiritimati');
const time = fc.option(fc.record({
	hour: fc.integer({ min: 0, max: 23 }),
	minute: fc.integer({ min: 0, max: 59 }),
	second: fc.option(fc.integer({ min: 0, max: 59 }), { nil: undefined }),
	millisecond: fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }),
}), { nil: undefined });
const days = fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }).map(values => values.sort((a, b) => a - b));

/** A rule in the shape validateRecurrence produces, without end conditions. */
const rule = fc.record({
	frequency: fc.constantFrom('daily' as const, 'weekly' as const, 'monthly' as const),
	interval: fc.option(fc.integer({ min: 2, max: 12 }), { nil: undefined }),
	daysOfWeek: fc.option(days, { nil: undefined }),
	dayOfMonth: fc.option(fc.integer({ min: 1, max: 31 }), { nil: undefined }),
	time,
}).map(({ frequency, interval, daysOfWeek, dayOfMonth, time }): RecurrenceRule => {
	const result: RecurrenceRule = { frequency };
	if (interval) result.interval = interval;
	if (frequency === 'weekly' && daysOfWeek) result.daysOfWeek = daysOfWeek;
	if (frequency === 'monthly' && dayOfMonth) result.dayOfMonth = dayOfMonth;
	if (time) {
		result.hour = time.hour;
		result.minute = time.minute;
		if (time.second !== undefined) result.second = time.second;
		if (time.millisecond !== undefined) result.millisecond = time.millisecond;
	}
	return result;
});
const zonedRule = fc.tuple(rule, zone).map(([value, timezone]) => ({ ...value, timezone }));
const due = fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true });
// Readable text never contains a marker start, so only the appended metadata is machine data.
const title = fc.string({ maxLength: 30 }).map(value => value.replace(/</g, ''));

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

describe('next occurrence', () => {
	it('is always strictly after the current due instant', () => {
		fc.assert(fc.property(zonedRule, due, (value, current) => {
			const next = calculateNextOccurrence(current, value);
			expect(next).not.toBeNull();
			expect(next!.getTime()).toBeGreaterThan(current.getTime());
		}), { numRuns: 300 });
	});

	it('lands on a selected weekday or the clamped day of the month', () => {
		fc.assert(fc.property(zonedRule, due, (value, current) => {
			const next = fromDate(calculateNextOccurrence(current, value)!, value.timezone);
			if (value.frequency === 'weekly' && value.daysOfWeek) {
				expect(value.daysOfWeek).toContain(getDayOfWeek(next, 'en-US'));
			}
			if (value.frequency === 'monthly' && value.dayOfMonth) {
				expect(next.day).toBe(Math.min(value.dayOfMonth, daysInMonth(next.year, next.month)));
			}
		}), { numRuns: 300 });
	});

	it('keeps the rule time in zones without daylight saving', () => {
		const fixedZone = fc.constantFrom('UTC', 'Asia/Kolkata', 'Pacific/Kiritimati');
		fc.assert(fc.property(rule, fixedZone, due, (value, timezone, current) => {
			if (value.hour === undefined) return;
			const next = fromDate(calculateNextOccurrence(current, { ...value, timezone })!, timezone);
			expect([next.hour, next.minute, next.second, next.millisecond])
				.toEqual([value.hour, value.minute, value.second ?? 0, value.millisecond ?? 0]);
		}), { numRuns: 200 });
	});

	it('stops exactly when the occurrence count is used up', () => {
		fc.assert(fc.property(zonedRule, due, fc.integer({ min: 1, max: 6 }), (value, start, count) => {
			let current = start;
			let produced = 0;
			for (let completed = 0; completed < count + 2; completed++) {
				const next = calculateNextOccurrence(current, { ...value, count }, completed);
				if (!next) {
					expect(completed + 1).toBeGreaterThanOrEqual(count);
					break;
				}
				produced++;
				current = next;
			}
			expect(produced).toBe(count - 1);
		}), { numRuns: 150 });
	});

	it('never returns an occurrence after a date-only end date', () => {
		const endDate = fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true })
			.map(date => date.toISOString().slice(0, 10));
		fc.assert(fc.property(zonedRule, due, endDate, (value, current, end) => {
			const next = calculateNextOccurrence(current, { ...value, endDate: end });
			if (!next) return;
			const zoned = fromDate(next, value.timezone);
			const key = `${zoned.year}-${String(zoned.month).padStart(2, '0')}-${String(zoned.day).padStart(2, '0')}`;
			expect(key <= end).toBe(true);
		}), { numRuns: 200 });
	});
});

describe('recurrence storage', () => {
	it('validation is idempotent and accepts only what it can read back', () => {
		const loose = fc.record({
			frequency: fc.constantFrom('daily', 'weekly', 'monthly', 'yearly', 3),
			interval: fc.oneof(fc.integer({ min: -2, max: 400 }), fc.constant('2')),
			daysOfWeek: fc.array(fc.integer({ min: -1, max: 7 }), { maxLength: 9 }),
			dayOfMonth: fc.integer({ min: 0, max: 32 }),
			hour: fc.integer({ min: -1, max: 24 }),
			minute: fc.integer({ min: 0, max: 59 }),
			timezone: fc.constantFrom('UTC', 'Europe/London', '', 'Not/AZone'),
			endDate: fc.constantFrom('2026-02-28', '2026-02-30', '2026-03-01T09:00:00Z', 'tomorrow'),
		}, { requiredKeys: [] });
		fc.assert(fc.property(loose, (raw) => {
			const first = validateRecurrence(raw);
			if (!('rule' in first)) return;
			expect(validateRecurrence(first.rule)).toEqual(first);
			expect(validateRecurrence(JSON.parse(JSON.stringify(first.rule)))).toEqual(first);
		}), { numRuns: 300 });
	});

	it('reads back the exact rule appended to a title that shows it', () => {
		fc.assert(fc.property(title, fc.oneof(rule, zonedRule), (text, value) => {
			const visible = `${text} ${recurrenceToText(value)}`;
			for (const persisted of [false, true]) {
				const read = readRecurrenceMetadata(appendRecurrenceMetadata(visible, value), { persisted });
				expect(read).toEqual({ content: visible.trimEnd(), recurrence: normalizeRecurrenceRule(value) });
			}
		}), { numRuns: 200 });
	});

	it('drops machine metadata once the visible rule text is edited away', () => {
		fc.assert(fc.property(title, fc.oneof(rule, zonedRule), (text, value) => {
			fc.pre(!text.includes(recurrenceToText(value)));
			const read = readRecurrenceMetadata(appendRecurrenceMetadata(text, value));
			expect(read).toEqual({ content: text.trimEnd(), recurrence: undefined });
		}), { numRuns: 200 });
	});

	it('parses the text of a generated rule back to the same local rule', () => {
		// Text omits a zero second or millisecond, which means the same as leaving it unset.
		const withoutZeroPrecision = ({ second, millisecond, ...rest }: RecurrenceRule): RecurrenceRule =>
			({ ...rest, ...(second ? { second } : {}), ...(millisecond ? { millisecond } : {}) });
		fc.assert(fc.property(rule, (value) => {
			const expected = normalizeRecurrenceRule(value);
			const parsed = parseRecurrenceFromContent(recurrenceToText(expected))?.rule;
			expect(parsed && withoutZeroPrecision(parsed)).toEqual(withoutZeroPrecision(expected));
		}), { numRuns: 200 });
	});
});
