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

	it('keeps locale-specific clock output for English users', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 1, 10, 0));

		expect(formatDueDate('2026-09-01T08:15:00', 'en-US')).toBe('Today, 08:15 AM');
	});
});
