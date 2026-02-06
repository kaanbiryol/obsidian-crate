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
}

export interface FileEntry {
	hash: string;
	size: number;
	modified: string;
}

// ============================================================================
// Tombstone Types
// ============================================================================

export interface Tombstone {
	path: string;
	deletedAt: string;
	expiresAt: string;
}

export interface TombstoneStore {
	deleted: Tombstone[];
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
}

export interface SyncResult {
	success: boolean;
	uploaded: number;
	downloaded: number;
	deleted: number;
	conflicts: string[];
	errors: string[];
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
}

export interface CheckResponse {
	lastSeq: number;
	hasChanges: boolean;
}

// ============================================================================
// API Types
// ============================================================================

export interface UploadFile {
	path: string;
	content: string;
	hash: string;
	size: number;
	mtime?: number;
	binary?: boolean;
	contentType?: string;
}

export interface UploadResponse {
	success: boolean;
	results: Array<{
		path: string;
		success?: boolean;
		error?: string;
	}>;
}

export interface DownloadResponse {
	path: string;
	content: string;
	contentType: string;
	size: number;
}

export interface BatchDownloadResponse {
	files: Array<{
		path: string;
		content?: string;
		contentType?: string;
		size?: number;
		error?: string;
	}>;
}

export interface HealthResponse {
	status: string;
	timestamp: string;
	version?: string;
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
		'.obsidian/cache',
		'.git/',
		'.trash/',
		'*.tmp',
		'.DS_Store',
	],
	syncOnStartup: true,
	syncInterval: 300,
	showStatusBar: true,
};

// ============================================================================
// Config Types (from CLI output)
// ============================================================================

export interface CrateConfig {
	workerUrl: string;
	token: string;
}

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

export const DEBOUNCE_DELAY_MS = 10000;
export const TOMBSTONE_TTL_DAYS = 30;
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
