import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import { readReminderListBody } from './reminder-api';
import type { CachedReminderSnapshot, ReminderRecord, ReminderSourceIssue } from './types';

export const INVALID_REMINDER_LIST_MESSAGE = 'The server returned invalid reminder data. Refresh reminders.';

export type ReminderListResponseOutcome =
	/** The confirmed list is still current; only its freshness changes. */
	| { kind: 'not-modified' }
	/** A contract failure cannot replace a valid revision or its ETag, including with an
	 * older disk snapshot after a recent acknowledgement. */
	| { kind: 'invalid'; dropDeltaBase: boolean; message: string; showErrorState: boolean }
	| {
		kind: 'loaded';
		dropDeltaBase: boolean;
		result: { reminders: ReminderRecord[]; projects: string[]; issues: ReminderSourceIssue[] };
		etag?: string;
		deltaBase?: string;
	};

/** Decides what a settled reminder list response means for the confirmed snapshot.
 * `body` is the parsed JSON (null when unreadable) and is ignored for a 304. */
export function decideReminderListResponse(
	response: { status: number; headers: Headers; body: unknown },
	context: { folderPath: string; confirmed: ReminderRecord[]; since?: string; lastCheckedAt: number | null },
): ReminderListResponseOutcome {
	if (response.status === 304) return { kind: 'not-modified' };
	const { result, dropDeltaBase } = readReminderListBody(response.body, context.folderPath, context.confirmed, context.since);
	if (!result) return { kind: 'invalid', dropDeltaBase, message: INVALID_REMINDER_LIST_MESSAGE, showErrorState: context.lastCheckedAt === null };
	return {
		kind: 'loaded', dropDeltaBase, result,
		etag: response.headers.get('ETag') ?? undefined,
		deltaBase: response.headers.get(DELTA_BASE_HEADER) ?? undefined,
	};
}

/** A loaded snapshot is at least as new as the disk copy, so only a first read falls back to disk. */
export function needsDiskFallback(lastCheckedAt: number | null): boolean {
	return lastCheckedAt === null;
}

export type ReminderListFailureOutcome =
	/** Keep the loaded snapshot and mark it stale. */
	| { kind: 'keep-stale'; message: string }
	| { kind: 'hydrate-cache'; cached: CachedReminderSnapshot; message: string }
	| { kind: 'error'; message: string };

/** Decides what a failed read shows. `cached` is the disk copy, read only when `needsDiskFallback`. */
export function decideReminderListFailure(
	error: unknown,
	context: { lastCheckedAt: number | null; cached?: CachedReminderSnapshot | null },
): ReminderListFailureOutcome {
	const message = error instanceof Error ? error.message : String(error);
	if (!needsDiskFallback(context.lastCheckedAt)) return { kind: 'keep-stale', message };
	if (context.cached) return { kind: 'hydrate-cache', cached: context.cached, message };
	return { kind: 'error', message };
}
