import type { FileEntry, UploadResult } from '../protocol/sync-types';
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
	): Promise<UploadResult>;
	batchDelete(paths: string[], expectedHashes?: Record<string, string>, expectedRevisions?: Record<string, string>): Promise<{
		success: boolean;
		deleted: string[];
		errors?: QueueDeleteFailure[];
	}>;
}

interface QueueManifest {
	getEntry(path: string): Readonly<FileEntry> | undefined;
	setEntry(path: string, entry: FileEntry): void;
	removeEntry(path: string): void;
	save(): Promise<void>;
}

interface QueueMarkdownBaseCache {
	putBase(path: string, hash: string, content: ArrayBuffer): Promise<void>;
}

export interface QueueDeleteCandidate {
	path: string;
	expectedHash: string;
	expectedRevision?: string;
}

export interface QueueDeleteFailure {
	path: string;
	error: string;
	status?: number;
}

export interface QueueUploadFailure {
	code?: string;
	path: string;
	error: string;
	status?: number;
}

export interface QueueFlushBatch {
	readonly paths: readonly string[];
	requeue(keys: Iterable<string>): void;
	settle(completedKeys: ReadonlySet<string>): void;
	release(): void;
}

export interface QueueFlushContext {
	finishInitialSetup(): Promise<void>;
	recoverUploads(): Promise<void>;
	getPendingPathCount(): number;
	beginBatch(): QueueFlushBatch;
	api: QueueApi;
	localManifest: QueueManifest;
	updateState(updates: Partial<SyncState>): void;
	isDestroyed(): boolean;
	currentStatus(): SyncState['status'];
	markdownBaseCache?: QueueMarkdownBaseCache;
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
	assertLocalFileAbsent(path: string): Promise<void>;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
	triggerDebouncedSync(): void;
	requestReconciliation(queueKeys: string[]): void;
	onFlushResult?(result: SyncResult): void | Promise<void>;
}
