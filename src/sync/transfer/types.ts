import type { PlannedContent } from '../planner/planned-content';
import type { TAbstractFile, Vault } from "obsidian";
import type { DownloadedBatch, DownloadedFile } from '../worker-api/sync';
import type { BatchUploadFile, BatchUploadResponse, FileEntry, UploadResult } from '../../protocol/sync-types';
import type { RecordConflictInput } from '../conflict/store';
import type { UploadApplyPhase } from '../diagnostics/upload-diagnostics';

interface TransferManifest {
	getEntry(path: string): Readonly<FileEntry> | undefined;
	hashMatches(path: string, hash: string): boolean;
	setEntry(path: string, entry: FileEntry): void;
	removeEntry(path: string): void;
}

interface TransferMarkdownBaseCache {
	readBase(path: string, hash: string): Promise<ArrayBuffer | null>;
	putBase(path: string, hash: string, content: ArrayBuffer): Promise<void>;
}

interface TransferConflictStore {
	record(conflict: RecordConflictInput): Promise<void>;
	resolveAppliedIncoming?(path: string, hash: string): Promise<void>;
	findIncomingReview?(originalPath: string, remoteHash: string, localHash: string): { conflictPath: string } | undefined;
}

interface TransferApi {
	recordMergeApplication?(path: string, hash: string, phase: UploadApplyPhase): Promise<void>;
	uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
	expectedHash: string | null,
	operationId?: string,
	mergePreimage?: ArrayBuffer,
	): Promise<UploadResult>;
	downloadFile(path: string): Promise<DownloadedFile>;
	batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse>;
	batchDownload(paths: string[]): Promise<DownloadedBatch>;
}

export interface TransferContext {
	plannedContent?: PlannedContent;
	vault: Vault;
	fileManager: {
		trashFile(file: TAbstractFile): Promise<void>;
	};
	/** The engine's journaled file operations. */
	files: TransferApi;
	localManifest: TransferManifest;
	markdownBaseCache?: TransferMarkdownBaseCache;
	conflictStore?: TransferConflictStore;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	retryWithBackoff<T>(fn: () => Promise<T>): Promise<T>;
	getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
}

export type DiffApplyOutcome =
	| { status: "applied" }
	| { status: "deferred"; reason: string };
