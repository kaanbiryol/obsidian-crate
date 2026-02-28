/**
 * Shared types for Obsidian Crate plugin
 */

// ============================================================================
// Manifest Types
// ============================================================================

export interface FileManifest {
	version: number;
	files: Record<string, FileEntry>;
	lastSeq?: number;
	truncated?: boolean;
}

export interface FileEntry {
	hash: string;
	size: number;
	modified: string;
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
	deleted: number;
	conflicts: string[];
	errors: string[];
	uploadedPaths: string[];
	downloadedPaths: string[];
	deletedPaths: string[];
}

export interface SyncHistoryEntry {
	timestamp: string; // ISO 8601
	type: 'sync' | 'initial' | 'force';
	success: boolean;
	uploaded: number;
	downloaded: number;
	deleted: number;
	errorCount: number;
	conflictCount: number;
	uploadedPaths?: string[];
	downloadedPaths?: string[];
	deletedPaths?: string[];
}

export interface FileDiff {
	path: string;
	action: 'upload' | 'download' | 'delete' | 'conflict';
	localHash?: string;
	remoteHash?: string;
}

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
}

export interface UploadResult {
	success: boolean;
	path: string;
	hash?: string;
	error?: string;
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
}

export interface BatchUploadResponse {
	success: boolean;
	results: Array<{ path: string; success: boolean; hash?: string; error?: string }>;
}

export interface BatchDownloadFile {
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
}

// ============================================================================
// Usage Types
// ============================================================================

export interface UsageMetric {
	current: number;
	limit: number;
	unit: string;
}

export interface UsageResponse {
	available: boolean;
	workers?: {
		requests: UsageMetric;
	};
	r2?: {
		storageBytes: UsageMetric;
		classAOps: UsageMetric;
		classBOps: UsageMetric;
	};
	d1?: {
		rowsRead: UsageMetric;
		rowsWritten: UsageMetric;
		storageBytes: UsageMetric;
	};
	queriedAt?: string;
	error?: string;
}

// ============================================================================
// Worker Config Types
// ============================================================================

export interface WorkerConfig {
	accountId: string | null;
	workerName: string | null;
	bucketName: string | null;
	databaseId: string | null;
}

// ============================================================================
// Settings Types
// ============================================================================

export interface CrateSettings {
	workerUrl: string;
	cloudflareAccountId: string;
	cloudflareTokenExpiresAt: number | null;
	workerName: string;
	bucketName: string;
	databaseId: string;
	lastSync: string | null;
	lastSeq: number;
	deviceId: string;
	ignorePatterns: string[];
	syncOnStartup: boolean;
	syncInterval: number; // in seconds, 0 = disabled
	showStatusBar: boolean;
	syncHistory: SyncHistoryEntry[];
}

export const DEFAULT_SETTINGS: CrateSettings = {
	workerUrl: '',
	cloudflareAccountId: '',
	cloudflareTokenExpiresAt: null,
	workerName: '',
	bucketName: '',
	databaseId: '',
	lastSync: null,
	lastSeq: 0,
	deviceId: '',
	ignorePatterns: [
		'.obsidian/workspace*',
		'.git/',
		'.trash/',
		'*.tmp',
		'.DS_Store',
	],
	syncOnStartup: true,
	syncInterval: 300,
	showStatusBar: true,
	syncHistory: [],
};

// ============================================================================
// Constants
// ============================================================================

export const SECRET_KEYS = {
	AUTH_TOKEN: 'crate-auth-token',
	ANALYTICS_TOKEN: 'crate-analytics-token',
	CLOUDFLARE_API_TOKEN: 'crate-cloudflare-api-token',
	CLOUDFLARE_REFRESH_TOKEN: 'crate-cloudflare-refresh-token',
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];

export const MAX_SYNC_HISTORY = 20;
export const DEBOUNCE_DELAY_MS = 5000;
export const MAX_DEBOUNCE_WAIT_MS = 30_000;
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
export const BATCH_MAX_FILES = 50;
export const BATCH_MAX_BYTES = 10 * 1024 * 1024; // 10MB total decoded content per batch upload
export const BATCH_FILE_SIZE_LIMIT = 1 * 1024 * 1024; // 1MB - files >= this fall back to individual uploads
