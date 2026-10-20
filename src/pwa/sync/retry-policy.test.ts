import { expect, it } from 'vitest';
import { automaticRetryDelayMs, hasAutomaticRetry } from './retry-policy';

it('allows three automatic attempts with doubling delays', () => {
	expect([1, 2, 3].map(automaticRetryDelayMs)).toEqual([2_000, 4_000, 8_000]);
	expect([0, 1, 2, 3].map(hasAutomaticRetry)).toEqual([true, true, true, false]);
});
