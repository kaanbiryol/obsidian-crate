import { describe, expect, it } from 'vitest';
import { validateRecurrence } from './validateRecurrence';

describe('validateRecurrence', () => {
	it('accepts a complete rule and normalizes weekdays', () => {
		expect(validateRecurrence({
			frequency: 'weekly', interval: 2, daysOfWeek: [3, 1, 3], hour: 9, minute: 30,
			timezone: 'Europe/Berlin', endDate: '2026-12-31', count: 10, completedCount: 2,
		})).toMatchObject({ rule: { frequency: 'weekly', interval: 2, daysOfWeek: [1, 3], timezone: 'Europe/Berlin', endDate: '2026-12-31', count: 10, completedCount: 2 } });
	});

	it.each([
		[null, 'Invalid recurrence'],
		[[], 'Invalid recurrence'],
		[{ frequency: 'yearly' }, 'Invalid recurrence frequency'],
		[{ frequency: 'daily', interval: 0 }, 'Invalid recurrence interval'],
		[{ frequency: 'daily', interval: 366 }, 'Invalid recurrence interval'],
		[{ frequency: 'monthly', dayOfMonth: 32 }, 'Invalid recurrence dayOfMonth'],
		[{ frequency: 'daily', hour: 1.5 }, 'Invalid recurrence hour'],
		[{ frequency: 'daily', count: 0 }, 'Invalid recurrence count'],
		[{ frequency: 'daily', completedCount: -1 }, 'Invalid recurrence completedCount'],
		[{ frequency: 'weekly', daysOfWeek: [7] }, 'Invalid recurrence daysOfWeek'],
		[{ frequency: 'weekly', daysOfWeek: [0, 1, 2, 3, 4, 5, 6, 0] }, 'Invalid recurrence daysOfWeek'],
		[{ frequency: 'daily', timezone: 'Mars/Olympus' }, 'Invalid recurrence timezone'],
		[{ frequency: 'daily', timezone: ' ' }, 'Invalid recurrence timezone'],
		[{ frequency: 'daily', endDate: '2026-02-30' }, 'Invalid recurrence end date'],
		[{ frequency: 'daily', endDate: '2026-02-01T10:00' }, 'Invalid recurrence end date'],
	])('rejects %j', (value, error) => {
		expect(validateRecurrence(value)).toEqual({ error });
	});
});
