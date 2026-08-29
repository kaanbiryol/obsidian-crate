import { describe, expect, it } from 'vitest';
import { getToastDuration } from './useToast';

describe('PWA toast duration', () => {
	it('keeps successful saves visible long enough to read', () => {
		expect(getToastDuration('success')).toBe(2800);
	});

	it('keeps longer durations for informational and error messages', () => {
		expect(getToastDuration('info')).toBe(3200);
		expect(getToastDuration('error')).toBe(4200);
	});
});
