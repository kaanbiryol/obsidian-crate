/**
 * Shared types for Crate plugin
 */

// ============================================================================
// Manifest Types
// ============================================================================

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
	size: number;
	modified: string;
}

export interface FileMetadataResponse {
	files: Record<string, FileEntry>;
}

// ============================================================================
// Sync Types
// ============================================================================

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
	/** Paths of conflict copies that still require the user's attention. */
	conflicts: string[];
	unresolvedConflicts: UnresolvedConflict[];
	resolvedRaces: ResolvedSyncRace[];
	/** Queue keys proven reconciled by a targeted recovery pass. */
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
	localHash?: string;
	remoteHash?: string;
	baseHash?: string;
}

export interface ResolvedSyncRace {
	path: string;
	resolution: 'kept-local-edit' | 'kept-remote-edit';
}

export interface SyncHistoryEntry {
	timestamp: string; // ISO 8601
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

// ============================================================================
// Changelog Types
// ============================================================================

export interface ChangelogEntry {
	seq: number;
	path: string;
	action: 'put' | 'delete';
	hash: string;
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

// ============================================================================
// API Types
// ============================================================================

export interface PreparedUpload {
	path: string;
	content: ArrayBuffer;
	hash: string;
	size: number;
	mtime?: number;
	contentType?: string;
	expectedHash?: string | null;
}

export interface UploadResult {
	success: boolean;
	path: string;
	hash?: string;
	error?: string;
	code?: MutationFailureCode;
	status?: number;
	currentHash?: string | null;
}

type MutationFailureCode = 'version_conflict' | 'validation' | 'storage' | 'unknown';

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

// ============================================================================
// Batch API Types
// ============================================================================

export interface BatchUploadFile {
	path: string;
	content: string; // base64 encoded
	hash: string;
	size: number;
	contentType: string;
	expectedHash: string | null;
}

export interface BatchDeleteFile {
	path: string;
	expectedHash: string;
}

export interface BatchUploadResponse {
	success: boolean;
	results: Array<{
		path: string;
		success: boolean;
		hash?: string;
		error?: string;
		code?: MutationFailureCode;
		status?: number;
		currentHash?: string | null;
	}>;
}

interface BatchDownloadFile {
	path: string;
	content: string; // base64 encoded
	hash: string;
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
	size: number;
	reason: 'replaced' | 'deleted';
	created_at: string;
	expires_at: number;
}

// ============================================================================
// Settings Types
// ============================================================================

export interface CrateSettings {
	workerUrl: string;
	cloudflareDeployment: CloudflareDeploymentMetadata | null;
	lastSync: string | null;
	lastSeq: number;
	deviceId: string;
	ignorePatterns: string[];
	syncOnStartup: boolean;
	syncOnResume: boolean;
	syncInterval: number; // in seconds, 0 = disabled
	showStatusBar: boolean;
	syncHistory: SyncHistoryEntry[];
	pushEnabled: boolean;
	syncDebugLogging: boolean;
	debounceDelay: number; // seconds
}

/**
 * Non-secret identifiers used to make Cloudflare deployment retries and updates
 * converge on the same resources. OAuth credentials never belong in settings.
 */
export interface CloudflareDeploymentMetadata {
	deploymentId: string;
	accountId: string | null;
	accountName: string | null;
	workerName: string;
	d1DatabaseName: string;
	d1DatabaseId: string | null;
	r2BucketName: string;
	workersSubdomain: string | null;
	lastDeployedVersion: string | null;
	lastDeployedFingerprint: string | null;
}

export interface SharedSettings {
	ignorePatterns: string[];
	syncOnStartup: boolean;
	syncOnResume: boolean;
	syncInterval: number;
	showStatusBar: boolean;
	pushEnabled: boolean;
}

export const DEFAULT_SETTINGS: CrateSettings = {
	workerUrl: '',
	cloudflareDeployment: null,
	lastSync: null,
	lastSeq: 0,
	deviceId: '',
	ignorePatterns: [
		'.git/',
		'.trash/',
		'*.tmp',
		'.DS_Store',
	],
	syncOnStartup: true,
	syncOnResume: true,
	syncInterval: 300,
	showStatusBar: true,
	syncHistory: [],
	pushEnabled: false,
	syncDebugLogging: false,
	debounceDelay: 5,
};

// ============================================================================
// Constants
// ============================================================================

export const SECRET_KEYS = {
	AUTH_TOKEN: 'crate-auth-token',
	DEVICE_ID: 'crate-device-id',
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];

export const MAX_SYNC_HISTORY = 20;
export const MAX_SYNC_HISTORY_PATHS = 50;
export const MAX_DEBOUNCE_WAIT_MS = 30_000;
export {
	BATCH_DOWNLOAD_MAX_BYTES,
	BATCH_DOWNLOAD_MAX_FILES,
	BATCH_FILE_SIZE_LIMIT,
	BATCH_UPLOAD_MAX_BYTES as BATCH_MAX_BYTES,
	BATCH_UPLOAD_MAX_FILES as BATCH_MAX_FILES,
	MAX_FILE_SIZE_BYTES,
} from '../protocol/sync-limits';
