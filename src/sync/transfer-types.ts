import type { TAbstractFile, Vault } from "obsidian";
import type { BatchDownloadResponse, BatchUploadFile, BatchUploadResponse, FileEntry, UploadResult } from '../protocol/sync-types';
import type { RecordConflictInput } from './conflict-store';
import type { UploadApplyPhase } from './upload-diagnostics';

interface TransferManifest {
  getEntry?(path: string): FileEntry | undefined;
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
  downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number; hash: string; revision?: string }>;
  deleteFile(path: string, expectedHash: string, expectedRevision?: string): Promise<{ success: boolean; path: string }>;
  batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse>;
  batchDownload(paths: string[]): Promise<BatchDownloadResponse>;
}

export interface TransferContext {
  vault: Vault;
  fileManager: {
    trashFile(file: TAbstractFile): Promise<void>;
  };
  api: TransferApi;
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
