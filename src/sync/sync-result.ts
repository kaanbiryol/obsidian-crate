import type { ResolvedSyncRace, SyncResult } from '../plugin/types';

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
		unresolvedConflicts: [],
		resolvedRaces: [],
		settledPaths: [],
		errors: [],
		uploadedPaths: [],
		downloadedPaths: [],
		mergedPaths: [],
		deletedPaths: [],
	};
}

export function recordUnresolvedConflict(
	result: SyncResult,
	path: string,
	conflictPath: string,
): void {
	if (!result.conflicts.includes(conflictPath)) {
		result.conflicts.push(conflictPath);
	}
	if (!result.unresolvedConflicts.some((conflict) => conflict.conflictPath === conflictPath)) {
		result.unresolvedConflicts.push({ path, conflictPath });
	}
}

export function hasUnresolvedConflict(result: SyncResult, path: string): boolean {
	return result.unresolvedConflicts.some((conflict) => conflict.path === path);
}

export function recordResolvedRace(
	result: SyncResult,
	path: string,
	resolution: ResolvedSyncRace['resolution'],
): void {
	if (!result.resolvedRaces.some((race) => race.path === path && race.resolution === resolution)) {
		result.resolvedRaces.push({ path, resolution });
	}
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
