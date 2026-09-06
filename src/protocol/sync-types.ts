export interface FileManifest {
	version: number;
	files: Record<string, FileEntry>;
	lastSeq?: number;
	truncated?: boolean;
	hasMore?: boolean;
	nextCursor?: string;
	snapshotSeq?: number;
}

export interface FileEntry {
	hash: string;
	revision?: string;
	size: number;
	modified: string;
}

export interface FileMetadataResponse {
	files: Record<string, FileEntry>;
}

export interface ChangelogEntry {
	seq: number;
	path: string;
	action: 'put' | 'delete';
	hash: string;
	revision?: string;
	size: number;
	created_at: string;
}

export interface ChangesResponse {
	changes: ChangelogEntry[];
	lastSeq: number;
	hasMore: boolean;
	cursorExpired?: boolean;
}

export interface CheckResponse {
	lastSeq: number;
	hasChanges: boolean;
	cursorExpired?: boolean;
}

type MutationFailureCode = 'version_conflict' | 'validation' | 'storage' | 'unknown';

export interface UploadResult {
	success: boolean;
	path: string;
	hash?: string;
	revision?: string;
	error?: string;
	code?: MutationFailureCode;
	status?: number;
	currentHash?: string | null;
}

export interface MutationFailure {
	path: string;
	error: string;
	code?: MutationFailureCode;
	status?: number;
	currentHash?: string | null;
}

export interface HealthResponse {
	status: string;
	timestamp: string;
	version?: string;
}

export interface BatchUploadFile {
	path: string;
	content: string;
	hash: string;
	revision?: string;
	size: number;
	contentType: string;
	expectedHash: string | null;
}

export interface BatchDeleteFile {
	path: string;
	expectedHash: string;
	expectedRevision?: string;
}

export interface BatchUploadResponse {
	success: boolean;
	results: Array<{
		path: string;
		success: boolean;
		hash?: string;
	revision?: string;
		error?: string;
		code?: MutationFailureCode;
		status?: number;
		currentHash?: string | null;
	}>;
}

interface BatchDownloadFile {
	path: string;
	content: string;
	hash: string;
	revision?: string;
	size: number;
	contentType: string;
	error?: string;
}

export interface BatchDownloadResponse {
	files: BatchDownloadFile[];
}

export interface BatchDeleteResponse {
	success: boolean;
	deleted: string[];
	errors?: MutationFailure[];
}

export interface BackendDiagnostics {
	status: 'ok';
	counts: {
		files: number;
		changelog: number;
		retainedVersions: number;
		pendingObjectCleanup: number;
		pendingNotificationJobs: number;
		scheduledReminders: number;
		activeAuthTokens: number;
		activePushSubscriptions: number;
		disabledPushSubscriptions: number;
		pendingNotificationProjections?: number;
		failedNotificationProjections?: number;
		failedNotificationJobs?: number;
		reminderOperationReceipts?: number;
	};
	lastMaintenanceAt: string | null;
	lastMaintenanceError: string | null;
}

export interface RegisteredDevice {
	id: string;
	device_id: string | null;
	device_name: string | null;
	platform: string | null;
	created_at: string;
	last_seen_at: string | null;
	is_current: boolean;
}

export interface RemoteFileVersion {
	storage_key: string;
	path: string;
	hash: string;
	revision?: string;
	size: number;
	reason: 'replaced' | 'deleted';
	created_at: string;
	expires_at: number;
}
