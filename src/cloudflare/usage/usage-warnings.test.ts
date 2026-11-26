import { describe, expect, it } from 'vitest';
import type { UsageGroup } from './service';
import { currentUsageWarningState, newUsageWarnings, normalizeUsageWarningState } from './usage-warnings';

function groups(classA: number, storage: number): UsageGroup[] {
	return [
		{ label: 'Workers', metrics: [{ label: 'Requests', used: 99_000, allowance: 100_000 }] },
		{ label: 'D1', metrics: [{ label: 'Rows written', used: 100_000, allowance: 100_000 }] },
		{ label: 'R2', metrics: [
			{ label: 'Class A operations', key: 'r2-class-a', used: classA, allowance: 1_000_000 },
			{ label: 'Class B operations', key: 'r2-class-b', used: 0, allowance: 10_000_000 },
		] },
		{ label: 'Storage', metrics: [
			{ label: 'D1 storage', bytes: true, used: 5_000_000_000, allowance: 5_000_000_000 },
			{ label: 'R2 storage', key: 'r2-storage', bytes: true, used: storage, allowance: 10_000_000_000 },
		] },
	];
}
const november = new Date('2026-11-26T10:00:00Z');
const levels = (result: ReturnType<typeof newUsageWarnings>) => result.warnings.map(warning => `${warning.metric.key}:${warning.level}`);

describe('usage warnings', () => {
	it('warns only for R2, from 80% of a free allowance', () => {
		const result = newUsageWarnings(groups(799_999, 8_000_000_000), currentUsageWarningState(null, november));
		// Workers and D1 stop at their limits instead of billing, so they never warn.
		expect(levels(result)).toEqual(['r2-storage:80']);
		expect(result.warnings[0]?.percent).toBe(80);
	});

	it('shows each level once a month and passing the allowance covers the earlier level', () => {
		const first = newUsageWarnings(groups(800_000, 0), currentUsageWarningState(null, november));
		expect(levels(first)).toEqual(['r2-class-a:80']);
		expect(levels(newUsageWarnings(groups(900_000, 0), first.state))).toEqual([]);
		const passed = newUsageWarnings(groups(1_000_000, 10_500_000_000), first.state);
		expect(levels(passed)).toEqual(['r2-class-a:100', 'r2-storage:100']);
		expect(levels(newUsageWarnings(groups(800_000, 8_000_000_000), passed.state))).toEqual([]);
	});

	it('starts over in a new month', () => {
		const { state } = newUsageWarnings(groups(800_000, 0), currentUsageWarningState(null, november));
		expect(currentUsageWarningState({ ...state, pausedShown: true }, november)).toEqual({ ...state, pausedShown: true });
		const december = currentUsageWarningState({ ...state, pausedShown: true }, new Date('2026-12-01T00:00:00Z'));
		expect(december).toEqual({ month: '2026-12', shown: [] });
		expect(levels(newUsageWarnings(groups(800_000, 0), december))).toEqual(['r2-class-a:80']);
	});

	it('ignores a metric without an allowance and discards malformed saved state', () => {
		const metrics: UsageGroup[] = [{ label: 'R2', metrics: [{ label: 'Class A operations', key: 'r2-class-a', used: 5 }] }];
		expect(newUsageWarnings(metrics, currentUsageWarningState(null, november)).warnings).toEqual([]);
		expect(normalizeUsageWarningState({ month: '2026-11', shown: ['r2-storage:80'], pausedShown: true })).toEqual({ month: '2026-11', shown: ['r2-storage:80'], pausedShown: true });
		expect(normalizeUsageWarningState({ month: 'November', shown: [] })).toBeNull();
		expect(normalizeUsageWarningState({ month: '2026-11', shown: [1] })).toBeNull();
		expect(normalizeUsageWarningState(null)).toBeNull();
	});
});
