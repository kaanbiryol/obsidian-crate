import { getSyncPathIssue } from '../protocol/portable-path';
import { isSyncIssueCode } from '../protocol/sync-issues';
import { isRecord } from '../platform/validation';
import { errorMessage } from '../platform/logger';
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

export const OVERSIZED_LOCAL_FILE_MESSAGE = 'Skipped local file larger than 25MB; this file is not synced';

/** A file sync deliberately leaves out. It is reported as an issue, but it is not a
 * failure: it must not block the sync cursor, the queue or a completed sync. */
export class SkippedFileError extends Error {
	constructor(readonly path: string, readonly issue: SyncIssue = skippedFileIssue(path)) { super(issue.message); }
}

export const skippedFileIssue = (path: string): SyncIssue => ({ path, message: OVERSIZED_LOCAL_FILE_MESSAGE, code: 'file-too-large' });
export const oversizedRemoteFileIssue = (path: string): SyncIssue => ({ path, message: 'Skipped remote file larger than 25MB', code: 'file-too-large' });
/** The server may only create sealed notes; one that would replace or take the name of a synced file is not applied. */
export const rejectedSealedNoteIssue = (path: string): SyncIssue => ({ path,
	message: 'Skipped a note the server created because it would replace or take the name of a note already synced here. The local copy is unchanged.' });
/** Every encrypted folder name becomes a tag, so a file this deep exceeds the server path limit. */
export const deepEncryptedFileIssue = (path: string): SyncIssue => ({ path, code: 'unsupported-device-path',
	message: 'Skipped local file nested more than 36 folders deep, which an encrypted vault cannot sync. Move it higher, then sync again.' });

/** Records a remote change that was not applied. Incoming bytes saved for review are
 * reported without failing the sync, like a skipped file: the path keeps its baseline,
 * so the conflict is found again, while the cursor and unrelated deletes continue. */
export function recordDeferredChange(result: Pick<SyncResult, 'errors' | 'issues'>, deferral: { reason: string; review?: true }, path: string): void {
	if (deferral.review) (result.issues ??= []).push({ path, message: deferral.reason, code: 'incoming-review' });
	else recordSyncError(result, deferral.reason, path);
}

export function normalizeSyncIssues(value: unknown, limit = 50): SyncIssue[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, limit).flatMap((issue): SyncIssue[] => {
		if (!isRecord(issue) || typeof issue.message !== 'string' || !issue.message.trim()) return [];
		return [{ message: issue.message.slice(0, 4000),
			...(typeof issue.path === 'string' && !getSyncPathIssue(issue.path) ? { path: issue.path } : {}),
			...(issue.scope === 'reminders' ? { scope: 'reminders' as const } : {}),
			...(isSyncIssueCode(issue.code) ? { code: issue.code } : {}),
			...(typeof issue.line === 'number' && Number.isSafeInteger(issue.line) && issue.line > 0 ? { line: issue.line } : {}),
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
	if (error instanceof SkippedFileError) {
		(result.issues ??= []).push({ ...error.issue, path: path ?? error.path });
		return;
	}
	for (const issue of syncErrorIssues(error, path)) recordSyncIssue(result, issue);
}

/** Record a failure whose wording and code this repo owns. */
export function recordSyncIssue(result: Pick<SyncResult, 'errors' | 'issues'>, issue: SyncIssue): void {
	result.errors.push(formatSyncIssue(issue));
	(result.issues ??= []).push(issue);
}

/** Failures recorded only as text join the explicit issues; only explicit context enables file actions. */
export function getSyncIssues(value: { errors?: string[]; issues?: SyncIssue[] }): SyncIssue[] {
	const issues = [...(value.issues ?? [])];
	const recorded = new Set(issues.map(formatSyncIssue));
	for (const message of value.errors ?? []) if (!recorded.has(message)) issues.push({ message });
	return issues;
}
