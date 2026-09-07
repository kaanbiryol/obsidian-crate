const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const VERSION_CONFLICT_HTTP_STATUSES = new Set([409, 412]);

export function isQueueVersionConflict(status: number | undefined, code?: string): boolean {
	return code !== 'namespace_conflict' && status !== undefined && VERSION_CONFLICT_HTTP_STATUSES.has(status);
}

export function isQueueTerminalFailure(status: number | undefined, code?: string): boolean {
	return status !== undefined
		&& !RETRYABLE_HTTP_STATUSES.has(status)
		&& !isQueueVersionConflict(status, code);
}
