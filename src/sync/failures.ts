import type { UploadResult } from '../protocol/sync-types';
import { HttpError, SyncTransportError } from './worker-api/http';

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const VERSION_CONFLICT_HTTP_STATUSES = new Set([409, 412]);

export function isAuthError(error: unknown): boolean {
	return error instanceof HttpError && error.status === 401;
}

/** Request retries and queue requeues: anything but a non-retryable server status may succeed later. */
export function isRetryableSyncError(error: unknown): boolean {
	return !(error instanceof HttpError) || RETRYABLE_HTTP_STATUSES.has(error.status);
}

/** Incremental sync: only transport failures and retryable server statuses; local or protocol
 * errors may need a full reconciliation. */
export function isTransientSyncFailure(error: unknown): boolean {
	return error instanceof SyncTransportError || (error instanceof HttpError && RETRYABLE_HTTP_STATUSES.has(error.status));
}

/** The remote file changed since it was read, so the path can be replanned against fresh
 * metadata. A namespace conflict is not resolved by replanning. */
export function isVersionConflict(status: number | undefined, code?: string): boolean {
	return code === 'version_conflict'
		|| (code !== 'namespace_conflict' && status !== undefined && VERSION_CONFLICT_HTTP_STATUSES.has(status));
}

/** Queue flushes: a failure that neither a retry nor a targeted replan can fix. */
export function isQueueTerminalFailure(status: number | undefined, code?: string): boolean {
	return status !== undefined
		&& !RETRYABLE_HTTP_STATUSES.has(status)
		&& !isVersionConflict(status, code);
}

/** Upload and restore journals: the server refused the conditional write, so the operation
 * can never commit and its journal entry is settled. */
export function isRefusedWrite(status: number | undefined, code?: string): boolean {
	return status === 409 && (code === 'version_conflict' || code === 'namespace_conflict');
}

/** Upload preparation: only a stale precondition lets one undispatched file reconcile apart
 * from its batch; any other error fails the batch. */
export function isStalePreparedUpload(error: unknown): boolean {
	return error instanceof HttpError && error.status === 409 && error.code === 'version_conflict';
}

/** The failed upload receipt for a refused write; any other error is rethrown. */
export function refusedUploadResult(path: string, error: unknown): UploadResult {
	if (!(error instanceof HttpError) || !isRefusedWrite(error.status, error.code)) throw error;
	return { success: false, path, status: error.status, code: error.code as UploadResult['code'], error: error.message };
}
