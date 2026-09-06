export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

export interface SyncState {
	status: SyncStatus;
	lastSync: string | null;
	lastError: string | null;
	pendingChanges: number;
	conflictCount: number;
}

export interface SyncResult {
	success: boolean;
	uploaded: number;
	downloaded: number;
	merged: number;
	deleted: number;
	conflicts: string[];
	unresolvedConflicts: UnresolvedConflict[];
	resolvedRaces: ResolvedSyncRace[];
	settledPaths: string[];
	errors: string[];
	uploadedPaths: string[];
	downloadedPaths: string[];
	mergedPaths: string[];
	deletedPaths: string[];
}

interface UnresolvedConflict {
	path: string;
	conflictPath: string;
}

export interface ConflictRecord {
	originalPath: string;
	conflictPath: string;
	createdAt: string;
	cause: 'concurrent-create' | 'concurrent-edit' | 'unknown';
	status: 'active' | 'resolved';
	copySide?: 'local' | 'remote';
	localHash?: string;
	remoteHash?: string;
	baseHash?: string;
}

export interface ResolvedSyncRace {
	path: string;
	resolution: 'kept-local-edit' | 'kept-remote-edit';
}

export interface SyncHistoryEntry {
	timestamp: string;
	type: 'sync' | 'initial' | 'force';
	success: boolean;
	uploaded: number;
	downloaded: number;
	merged: number;
	deleted: number;
	errorCount: number;
	conflictCount: number;
	resolvedRaceCount?: number;
	conflictPaths?: string[];
	resolvedRaces?: ResolvedSyncRace[];
	uploadedPaths?: string[];
	downloadedPaths?: string[];
	mergedPaths?: string[];
	deletedPaths?: string[];
}

interface ReconcileDecisionBase {
	path: string;
	remoteRevision?: string;
}

export type FileDiff =
	| (ReconcileDecisionBase & {
		action: 'upload';
		localHash: string;
		remoteHash?: string;
		cause: 'local-created' | 'local-edited' | 'remote-deleted';
	})
	| (ReconcileDecisionBase & {
		action: 'download';
		localHash?: string;
		remoteHash: string;
		cause: 'remote-created' | 'remote-edited' | 'local-deleted';
	})
	| (ReconcileDecisionBase & {
		action: 'conflict';
		localHash: string;
		remoteHash: string;
		cause: 'concurrent-create' | 'concurrent-edit';
	})
	| (ReconcileDecisionBase & {
		action: 'delete';
		remoteHash: string;
		cause: 'local-deleted';
	})
	| (ReconcileDecisionBase & {
		action: 'delete-local';
		localHash: string;
		cause: 'remote-deleted';
	});

export type UploadDiff = Extract<FileDiff, { action: 'upload' }>;
export type DownloadDiff = Extract<FileDiff, { action: 'download' }>;
export type ConflictDiff = Extract<FileDiff, { action: 'conflict' }>;

export interface PreparedUpload {
	path: string;
	content: ArrayBuffer;
	hash: string;
	size: number;
	mtime?: number;
	contentType?: string;
	expectedHash?: string | null;
}
