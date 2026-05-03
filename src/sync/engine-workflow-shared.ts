import type { FileDiff, FileEntry, SyncResult, SyncState } from '../plugin/types';
import { createSyncFailureResult, SYNC_ERROR_MESSAGES } from './sync-result';

export type SyncStatus = SyncState['status'];

export interface RemoteManifest {
	files: Record<string, FileEntry>;
	lastSeq?: number;
}

export interface FullSyncPlan {
	localFiles: Record<string, FileEntry>;
	diffs: FileDiff[];
	uploadDiffs: FileDiff[];
	downloadDiffs: FileDiff[];
	remainingDiffs: FileDiff[];
	errors: string[];
}

export function getStartFailureResult(context: {
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
}): SyncResult | null {
	if (!context.apiConfigured()) {
		return createSyncFailureResult(SYNC_ERROR_MESSAGES.NOT_CONFIGURED);
	}
	if (context.getStatus() === 'syncing') {
		return createSyncFailureResult(SYNC_ERROR_MESSAGES.ALREADY_IN_PROGRESS);
	}
	return null;
}
