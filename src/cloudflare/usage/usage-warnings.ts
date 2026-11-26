import type { BilledUsageMetric, UsageGroup, UsageMetric } from './service';

/** Shares of a free allowance that warn: close to it, then past it. */
const LEVELS = [80, 100] as const;
type UsageWarningLevel = typeof LEVELS[number];

/** Warnings this device already showed in `month` (UTC, `YYYY-MM`), as `metric:level`. */
export interface UsageWarningState {
	month: string;
	shown: string[];
	/** This device said this month that warnings are paused until Cloudflare is reconnected. */
	pausedShown?: boolean;
}

export interface UsageWarning { metric: UsageMetric & { key: BilledUsageMetric; allowance: number }; level: UsageWarningLevel; percent: number }

const BILLED = new Set<string>(['r2-class-a', 'r2-class-b', 'r2-storage'] satisfies BilledUsageMetric[]);

export function normalizeUsageWarningState(value: unknown): UsageWarningState | null {
	const state = value as UsageWarningState | null | undefined;
	if (!state || typeof state.month !== 'string' || !/^\d{4}-\d{2}$/.test(state.month)
		|| !Array.isArray(state.shown) || state.shown.length > 20 || !state.shown.every(id => typeof id === 'string')) return null;
	return { month: state.month, shown: [...state.shown], ...(state.pausedShown === true ? { pausedShown: true } : {}) };
}

/** This month's state, starting over when the month changed. */
export function currentUsageWarningState(state: UsageWarningState | null | undefined, now: Date): UsageWarningState {
	const month = now.toISOString().slice(0, 7);
	return state?.month === month ? state : { month, shown: [] };
}

/**
 * R2 metrics that reached a warning level not yet shown this month. Only R2 is
 * included: Workers and D1 stop at their free limits, while R2 bills past them.
 */
export function newUsageWarnings(groups: readonly UsageGroup[], state: UsageWarningState): { warnings: UsageWarning[]; state: UsageWarningState } {
	const shown = new Set(state.shown);
	const warnings: UsageWarning[] = [];
	for (const metric of groups.flatMap(group => group.metrics)) {
		if (!metric.key || !BILLED.has(metric.key) || !metric.allowance) continue;
		const percent = metric.used / metric.allowance * 100;
		const level = [...LEVELS].reverse().find(threshold => percent >= threshold);
		if (!level || shown.has(`${metric.key}:${level}`)) continue;
		// Passing the allowance also covers the earlier warning.
		for (const threshold of LEVELS) if (threshold <= level) shown.add(`${metric.key}:${threshold}`);
		warnings.push({ metric: metric as UsageWarning['metric'], level, percent });
	}
	return { warnings, state: { ...state, shown: [...shown] } };
}
