import { expect, it } from 'vitest';
import { MAX_HISTORY_RETENTION_MS, DAY_MS, parseHistoryRetention } from './history-retention';

it('accepts only the offered retention periods', () => {
	for (const days of [7, 14, 30, 60, 90]) expect(parseHistoryRetention({ days })).toEqual({ days });
	for (const value of [{ days: 45 }, { days: 365 }, { days: '30' }, { days: 0 }, {}, null, 30]) expect(parseHistoryRetention(value)).toBeNull();
	expect(MAX_HISTORY_RETENTION_MS).toBe(90 * DAY_MS);
});
