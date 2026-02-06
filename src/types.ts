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
// Settings Types
// ============================================================================

export interface CrateSettings {
	workerUrl: string;
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
	lastSync: null,
	lastSeq: 0,
	deviceId: '',
	ignorePatterns: [
		'.obsidian/workspace*',
		'.obsidian/cache',
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
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];
export interface MergeResult {
	success: boolean;
	merged?: string;
}

export const MERGEABLE_EXTENSIONS = ['md', 'txt'] as const;

export const DEBOUNCE_DELAY_MS = 10000;
export const TOMBSTONE_TTL_DAYS = 30;
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
