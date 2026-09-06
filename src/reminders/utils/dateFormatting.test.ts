import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateHeader, formatDueDate } from './dateFormatting';

describe('localized reminder date formatting', () => {
	afterEach(() => vi.useRealTimers());

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
});
