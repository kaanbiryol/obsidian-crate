import type { UploadPreparedFilesOptions } from './transfer-upload';
import type { DeleteRemoteFiles } from './transfer-delete';
import type { ConditionalDeleteCandidate } from './delete-batches';
import type { FileEntry, MutationFailure } from '../protocol/sync-types';
import type { PreparedUpload, SyncResult, SyncState } from './types';

interface QueueApi {
	isConfigured(): boolean;
}

interface QueueManifest {
	getEntry(path: string): Readonly<FileEntry> | undefined;
	save(): Promise<void>;
}

export type QueueDeleteCandidate = ConditionalDeleteCandidate;
export type QueueDeleteFailure = MutationFailure;

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
	uploadPreparedFiles(prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void>;
	deleteRemoteFiles: DeleteRemoteFiles;
	recoverUploads(): Promise<void>;
	getPendingPathCount(): number;
	beginBatch(): QueueFlushBatch;
	api: QueueApi;
	localManifest: QueueManifest;
	updateState(updates: Partial<SyncState>): void;
	isDestroyed(): boolean;
	currentStatus(): SyncState['status'];
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
	triggerDebouncedSync(): void;
	requestReconciliation(queueKeys: string[]): void;
	onFlushResult?(result: SyncResult): void | Promise<void>;
}
