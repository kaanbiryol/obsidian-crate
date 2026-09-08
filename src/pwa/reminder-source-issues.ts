import type { ReminderSourceIssue } from './types';

/** An omitted optional API field is empty; cache readers separately reject legacy snapshots without it. */
export function parseReminderSourceIssues(value: unknown): ReminderSourceIssue[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const issues: ReminderSourceIssue[] = [];
	for (const item of value as unknown[]) {
		if (!item || typeof item !== 'object') return null;
		const issue = item as Partial<ReminderSourceIssue>;
		if (typeof issue.path !== 'string' || !issue.path || typeof issue.reason !== 'string' || !issue.reason) return null;
		issues.push({ path: issue.path, reason: issue.reason });
	}
	return issues;
}
