import type { SyncResult } from '../plugin/types';

export const SYNC_ERROR_MESSAGES = {
	NOT_CONFIGURED: 'Not configured',
	ALREADY_IN_PROGRESS: 'Sync already in progress',
} as const;

export function createEmptySyncResult(): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		merged: 0,
		deleted: 0,
		conflicts: [],
		errors: [],
		uploadedPaths: [],
		downloadedPaths: [],
		mergedPaths: [],
		deletedPaths: [],
	};
}

export function createSyncFailureResult(error: string): SyncResult {
	const result = createEmptySyncResult();
	result.success = false;
	result.errors.push(error);
	return result;
}

export function finalizeSyncResult(result: SyncResult): boolean {
	result.success = result.errors.length === 0;
	return result.success;
}

export function getSyncResultError(result: SyncResult, fallback: string): string {
	return result.errors[0] ?? fallback;
}
