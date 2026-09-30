import { getSyncPathIssue } from '../protocol/portable-path';
import { isRecord } from '../platform/validation';
import { errorMessage } from '../plugin/logger';
import { isAbortError } from './abort';
import type { SyncIssue, SyncResult } from './types';

// Preserve exception identity so cancellation, authentication and retry policy still work.
const fileContexts = new WeakMap<Error, SyncIssue[]>();

export async function withSyncFileContext<T>(paths: string | string[], operation: () => Promise<T>): Promise<T> {
	try { return await operation(); }
	catch (error) {
		if (error instanceof Error && !isAbortError(error) && !fileContexts.has(error)) {
			fileContexts.set(error, (typeof paths === 'string' ? [paths] : paths).map(path => ({ path, message: errorMessage(error) })));
		}
		throw error;
	}
}

export class SyncIssueError extends Error {
	constructor(message: string, readonly issues: SyncIssue[]) { super(message); }
}

export function normalizeSyncIssues(value: unknown, limit = 50): SyncIssue[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, limit).flatMap((issue): SyncIssue[] => {
		if (!isRecord(issue) || typeof issue.message !== 'string' || !issue.message.trim()) return [];
		return [{ message: issue.message.slice(0, 4000),
			...(typeof issue.path === 'string' && !getSyncPathIssue(issue.path) ? { path: issue.path } : {}),
			...(issue.scope === 'reminders' ? { scope: 'reminders' as const } : {}),
		}];
	});
}

export function formatSyncIssue(issue: SyncIssue): string {
	return issue.path && !issue.message.startsWith(`${issue.path}: `) ? `${issue.path}: ${issue.message}` : issue.message;
}

export function syncErrorIssues(error: unknown, path?: string): SyncIssue[] {
	if (error instanceof SyncIssueError) return error.issues;
	if (path) return [{ path, message: errorMessage(error) }];
	return (error instanceof Error ? fileContexts.get(error) : undefined) ?? [{ message: errorMessage(error) }];
}

/** Keep the legacy text log and explicit file context together at the failure site. */
export function recordSyncError(result: Pick<SyncResult, 'errors' | 'issues'>, error: unknown, path?: string): void {
	const issues = syncErrorIssues(error, path);
	result.errors.push(...issues.map(formatSyncIssue));
	(result.issues ??= []).push(...issues);
}

/** Older histories retain their original text; only explicit context enables file actions. */
export function getSyncIssues(value: { errors?: string[]; issues?: SyncIssue[] }): SyncIssue[] {
	const issues = [...(value.issues ?? [])];
	const recorded = new Set(issues.map(formatSyncIssue));
	for (const message of value.errors ?? []) if (!recorded.has(message)) issues.push({ message });
	return issues;
}
