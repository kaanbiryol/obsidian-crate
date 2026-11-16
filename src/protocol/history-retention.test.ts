import { expect, it } from 'vitest';
import { MAX_HISTORY_RETENTION_MS, DAY_MS, parseHistoryRetention } from './history-retention';

it('accepts only the offered retention periods', () => {
	for (const days of [7, 30, 90, 365]) expect(parseHistoryRetention({ days })).toEqual({ days });
	for (const value of [{ days: 14 }, { days: '30' }, { days: 0 }, {}, null, 30]) expect(parseHistoryRetention(value)).toBeNull();
	expect(MAX_HISTORY_RETENTION_MS).toBe(365 * DAY_MS);
});
