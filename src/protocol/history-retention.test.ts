import { expect, it } from 'vitest';
import { MAX_HISTORY_RETENTION_MS, DAY_MS, HISTORY_RETENTION_DAYS, parseHistoryRetention, SELF_HOSTED_HISTORY_RETENTION_DAYS } from './history-retention';

it('accepts only the offered retention periods', () => {
	for (const days of [7, 14, 30, 60, 90]) expect(parseHistoryRetention({ days })).toEqual({ days, options: HISTORY_RETENTION_DAYS });
	for (const value of [{ days: 45 }, { days: 365 }, { days: '30' }, { days: 0 }, {}, null, 30]) expect(parseHistoryRetention(value)).toBeNull();
	expect(MAX_HISTORY_RETENTION_MS).toBe(365 * DAY_MS);
});

it('accepts the longer periods a self-hosted server lists, and nothing outside them', () => {
	const options = [...SELF_HOSTED_HISTORY_RETENTION_DAYS];
	expect(parseHistoryRetention({ days: 365, options })).toEqual({ days: 365, options });
	expect(parseHistoryRetention({ days: 365, options: [7, 30] })).toBeNull();
	expect(parseHistoryRetention({ days: 30, options: [30, 1000] })).toEqual({ days: 30, options: HISTORY_RETENTION_DAYS });
});
