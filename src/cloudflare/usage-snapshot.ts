import type { UsageGroup } from './usage-service';

export interface UsageSnapshot {
	accountId: string;
	updatedAt: number;
	groups: UsageGroup[];
}

/** Discard malformed local cache data rather than rendering invalid numbers. */
export function normalizeUsageSnapshot(value: unknown): UsageSnapshot | null {
	if (!value || typeof value !== 'object') return null;
	const snapshot = value as UsageSnapshot;
	if (typeof snapshot.accountId !== 'string' || !snapshot.accountId
		|| !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt <= 0 || snapshot.updatedAt > 8.64e15
		|| !Array.isArray(snapshot.groups) || snapshot.groups.length > 10) return null;
	for (const group of snapshot.groups) {
		if (!group || typeof group.label !== 'string' || (group.error !== undefined && typeof group.error !== 'string')
			|| !Array.isArray(group.metrics) || group.metrics.length > 20) return null;
		for (const metric of group.metrics) {
			if (!metric || typeof metric.label !== 'string' || !Number.isFinite(metric.used) || metric.used < 0
				|| (metric.allowance !== undefined && (!Number.isFinite(metric.allowance) || metric.allowance < 0))
				|| (metric.bytes !== undefined && typeof metric.bytes !== 'boolean')) return null;
		}
	}
	return snapshot;
}
