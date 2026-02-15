import type { SyncResult } from '../types';

export const SYNC_ERROR_MESSAGES = {
	NOT_CONFIGURED: 'Not configured',
	ALREADY_IN_PROGRESS: 'Sync already in progress',
} as const;

export function createEmptySyncResult(): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		conflicts: [],
		errors: [],
	};
}

export function createSyncFailureResult(error: string): SyncResult {
	const result = createEmptySyncResult();
	result.success = false;
	result.errors.push(error);
	return result;
}

export function createNotConfiguredSyncResult(): SyncResult {
	return createSyncFailureResult(SYNC_ERROR_MESSAGES.NOT_CONFIGURED);
}

export function createSyncInProgressResult(): SyncResult {
	return createSyncFailureResult(SYNC_ERROR_MESSAGES.ALREADY_IN_PROGRESS);
}

export function finalizeSyncResult(result: SyncResult): boolean {
	result.success = result.errors.length === 0;
	return result.success;
}

export function getSyncResultError(result: SyncResult, fallback: string): string {
	return result.errors[0] ?? fallback;
}
