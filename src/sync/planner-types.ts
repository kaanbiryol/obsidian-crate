import type { TAbstractFile, Vault } from "obsidian";
import type { ChangelogEntry, FileEntry, MutationFailure } from '../protocol/sync-types';
import type { CrateSettings } from '../plugin/settings-types';
import type { DownloadDiff, FileDiff, PreparedUpload, SyncResult, UploadDiff } from './types';
import type { DownloadRequest } from './transfer-download';
import type { DiffApplyOutcome } from './transfer-types';
import type { UploadPreparedFilesOptions } from './transfer-upload';
import type { VaultFile } from './file-discovery';

interface PlannerManifest {
  getEntry(path: string): FileEntry | undefined;
  getAllPaths(): string[];
  getManifest(): { version: number; files: Record<string, FileEntry> };
  setEntry(path: string, entry: FileEntry): void;
  removeEntry(path: string): void;
  save(): Promise<void>;
}

interface PlannerApi {
  getChanges(since: number): Promise<{
    changes: ChangelogEntry[];
    lastSeq: number;
    hasMore: boolean;
    cursorExpired?: boolean;
  }>;
  downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number; hash: string; revision?: string }>;
  deleteFile(path: string, expectedHash: string, expectedRevision?: string): Promise<{ success: boolean; path: string }>;
  batchDelete(paths: string[], expectedHashes?: Record<string, string>, expectedRevisions?: Record<string, string>): Promise<{
    success: boolean;
    deleted: string[];
    errors?: MutationFailure[];
  }>;
}

export interface LocalDiffPlannerContext {
  vault: Vault;
  localManifest: PlannerManifest;
  shouldIgnore(path: string): boolean;
  verifyContent?(files: VaultFile[]): Promise<boolean>;
  runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
}

export interface IncrementalSyncPlannerContext {
  throwIfDestroyed?(): void;
  settings: CrateSettings;
  vault: Vault;
  fileManager: {
    trashFile(file: TAbstractFile): Promise<void>;
  };
  api: PlannerApi;
  localManifest: PlannerManifest;
  shouldIgnore(path: string): boolean;
  getLocalChanges(): Promise<{ path: string; hash: string }[]>;
  getLocalDeletes(): Promise<string[]>;
  parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult): Promise<void>;
  processDiff(
    diff: FileDiff,
    localFiles: Record<string, FileEntry>,
    result: SyncResult,
  ): Promise<DiffApplyOutcome>;
  prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
  uploadPreparedFiles(
    prepared: PreparedUpload[],
    result: SyncResult,
    options: UploadPreparedFilesOptions,
  ): Promise<void>;
	reconcileVersionConflicts?(paths: string[], result: SyncResult): Promise<void>;
}

export interface FullSyncPlannerContext {
  vault: Vault;
  localManifest: PlannerManifest;
  shouldIgnore(path: string): boolean;
  runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
}

export interface FullSyncPlan {
  localFiles: Record<string, FileEntry>;
  diffs: FileDiff[];
  uploadDiffs: UploadDiff[];
  downloadDiffs: DownloadDiff[];
  remainingDiffs: FileDiff[];
  errors: string[];
}
