import { expect, it } from 'vitest';
import { formatSize, formatTimeAgo } from './format';

const now = Date.parse('2026-10-26T12:00:00Z');

it.each([
	[-60_000, 'just now'], [59_999, 'just now'], [60_000, '1m ago'], [59 * 60_000, '59m ago'],
	[60 * 60_000, '1h ago'], [23 * 3_600_000 + 59 * 60_000, '23h ago'], [24 * 3_600_000, '1d ago'], [9 * 86_400_000, '9d ago'],
] as const)('labels a time %i ms ago as %s', (elapsed, label) => {
	expect(formatTimeAgo(now - elapsed, now)).toBe(label);
});

it.each([[0, '0 B'], [1023, '1023 B'], [1024, '1.0 KiB'], [250 * 1024, '250.0 KiB'], [25 * 1024 * 1024, '25.0 MiB']] as const)(
	'formats %i bytes as %s', (bytes, label) => {
		expect(formatSize(bytes)).toBe(label);
	});
