import type { PreparedUpload, SyncResult, SyncState } from './types';

interface QueueApi {
	isConfigured(): boolean;
	uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
		expectedHash: string | null,
	): Promise<{ success: boolean; path: string; hash?: string; error?: string }>;
	batchDelete(paths: string[], expectedHashes?: Record<string, string>): Promise<{
		success: boolean;
		deleted: string[];
		errors?: QueueDeleteFailure[];
	}>;
}

interface QueueManifest {
	getEntry?(path: string): { hash: string; size: number; modified: string } | undefined;
	setEntry(path: string, entry: { hash: string; size: number; modified: string }): void;
	removeEntry(path: string): void;
	save(): Promise<void>;
}

interface QueueMarkdownBaseCache {
	putBase(path: string, hash: string, content: ArrayBuffer): Promise<void>;
}

export interface QueueDeleteCandidate {
	path: string;
	expectedHash: string;
}

export interface QueueDeleteFailure {
	path: string;
	error: string;
	status?: number;
}

export interface QueueUploadFailure {
	path: string;
	error: string;
	status?: number;
}

export interface QueueFlushContext {
	pendingPaths: Set<string>;
	inFlightPaths: Set<string>;
	pendingRevisions?: Map<string, number>;
	api: QueueApi;
	localManifest: QueueManifest;
	updateState(updates: Partial<SyncState>): void;
	isDestroyed(): boolean;
	currentStatus(): SyncState['status'];
	markdownBaseCache?: QueueMarkdownBaseCache;
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
	triggerDebouncedSync(): void;
	requestReconciliation(queueKeys: string[]): void;
	onFlushResult?(result: SyncResult): void | Promise<void>;
}
