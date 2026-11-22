import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatCompletedAt, formatDateHeader, formatDueDate, resetDateFormatterCache } from './dateFormatting';

describe('localized reminder date formatting', () => {
	it('includes recurring wall-clock time for date-only occurrences', () => {
		const now = new Date(2026, 8, 1, 10);
		for (const frequency of ['daily', 'weekly', 'monthly'] as const) {
			expect(formatDueDate('2026-09-02', 'en-US', now, { frequency, hour: 9, minute: 15 })).toBe('Tomorrow, 09:15');
		}
		expect(formatDueDate('2026-09-02', 'de-DE', now, { frequency: 'daily', hour: 0 })).toBe('Morgen, 00:00');
		expect(formatDueDate('2026-09-02', 'en-US', now, { frequency: 'daily' })).toBe('Tomorrow');
		expect(formatDueDate('2026-09-02T11:00:00', 'en-US', now, { frequency: 'daily', hour: 9 })).toBe('Tomorrow, 11:00');
	});

	afterEach(() => vi.useRealTimers());

	it('formats completion times relative to today, with the year only when it differs', () => {
		const now = new Date(2026, 10, 22, 12);
		const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();
		expect(formatCompletedAt(at(2026, 10, 22, 10, 15), 'en-US', now)).toBe('Today, 10:15');
		expect(formatCompletedAt(at(2026, 10, 21, 18, 40), 'en-US', now)).toBe('Yesterday, 18:40');
		expect(formatCompletedAt(at(2026, 10, 18, 9, 2), 'en-US', now)).toBe('Nov 18, 09:02');
		expect(formatCompletedAt(at(2025, 10, 18, 9, 2), 'en-US', now)).toBe('Nov 18, 2025, 09:02');
		expect(formatCompletedAt(at(2026, 10, 22, 10, 15), 'en-US', now, true)).toBe('today at 10:15');
		expect(formatCompletedAt('not a date', 'en-US', now)).toBeNull();
	});

	it('uses localized relative dates and time conventions', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 1, 10, 0));

		expect(formatDueDate('2026-09-01T08:15:00', 'de-DE')).toBe('Heute, 08:15');
		expect(formatDateHeader(new Date(2026, 8, 2), 'de-DE')).toBe('Morgen');
	});

	it('uses a 24-hour clock for English users', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 1, 10, 0));

		expect(formatDueDate('2026-09-01T08:15:00', 'en-US')).toBe('Today, 08:15');
		expect(formatDueDate('2026-09-01T18:15:00', 'en-US')).toBe('Today, 18:15');
		expect(formatDueDate('2026-09-01T00:00:00', 'en-US')).toBe('Today, 00:00');
	});

	it('reuses formatters across calls and rebuilds them after a reset', () => {
		const now = new Date(2026, 8, 1, 10);
		resetDateFormatterCache();
		const counts = { date: 0, relative: 0 };
		const countConstructions = <T extends object>(target: T, key: keyof typeof counts) =>
			new Proxy(target, { construct: (ctor, args) => { counts[key]++; return Reflect.construct(ctor as never, args); } });
		vi.stubGlobal('Intl', Object.assign(Object.create(Intl) as typeof Intl, { DateTimeFormat: countConstructions(Intl.DateTimeFormat, 'date'), RelativeTimeFormat: countConstructions(Intl.RelativeTimeFormat, 'relative') }));
		try {
			for (let i = 0; i < 50; i++) {
				expect(formatDueDate('2026-09-01T08:15:00', 'en-US', now)).toBe('Today, 08:15');
				expect(formatDueDate('2026-09-10', 'en-US', now)).toBe('Sep 10');
				expect(formatDateHeader(new Date(2026, 8, 10), 'en-US', now)).toBe('Thursday, Sep 10');
			}
			expect(counts.date).toBe(3);
			expect(counts.relative).toBe(1);
			formatDueDate('2026-09-10', 'de-DE', now);
			expect(counts.date).toBe(4);
			resetDateFormatterCache();
			formatDueDate('2026-09-10', 'en-US', now);
			expect(counts.date).toBe(5);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
