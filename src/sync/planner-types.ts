import type { TAbstractFile, Vault } from "obsidian";
import type { ChangelogEntry, CrateSettings, FileDiff, FileEntry, PreparedUpload, SyncResult } from "../plugin/types";

export interface PlannerManifest {
  getEntry(path: string): FileEntry | undefined;
  getAllPaths(): string[];
  getManifest(): { version: number; files: Record<string, FileEntry> };
  setEntry(path: string, entry: FileEntry): void;
  removeEntry(path: string): void;
  save(): Promise<void>;
}

export interface PlannerApi {
  getChanges(since: number): Promise<{
    changes: ChangelogEntry[];
    lastSeq: number;
    hasMore: boolean;
    cursorExpired?: boolean;
  }>;
  downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number }>;
  deleteFile(path: string): Promise<{ success: boolean; path: string }>;
  batchDelete(paths: string[]): Promise<{
    success: boolean;
    deleted: string[];
    errors?: Array<{ path: string; error: string }>;
  }>;
}

export interface LocalDiffPlannerContext {
  vault: Vault;
  localManifest: PlannerManifest;
  shouldIgnore(path: string): boolean;
  runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
}

export interface IncrementalSyncPlannerContext {
  settings: CrateSettings;
  vault: Vault;
  fileManager?: {
    trashFile(file: TAbstractFile): Promise<void>;
  };
  api: PlannerApi;
  localManifest: PlannerManifest;
  shouldIgnore(path: string): boolean;
  getLocalChanges(): Promise<{ path: string; hash: string }[]>;
  getLocalDeletes(): Promise<string[]>;
  parallelDownloadAndSaveFiles(paths: string[], result: SyncResult): Promise<void>;
  processDiff(
    diff: FileDiff,
    localFiles: Record<string, FileEntry>,
    result: SyncResult,
  ): Promise<void>;
  prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
  uploadPreparedFiles(
    prepared: PreparedUpload[],
    result: SyncResult,
    options: { concurrency: number; retry: boolean; batchConcurrency?: number },
  ): Promise<void>;
}

export interface FullSyncPlannerContext {
  vault: Vault;
  localManifest: PlannerManifest;
  shouldIgnore(path: string): boolean;
  runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
  getLocalDeletes(): Promise<string[]>;
}

export interface FullSyncPlan {
  localFiles: Record<string, FileEntry>;
  diffs: FileDiff[];
  uploadDiffs: FileDiff[];
  downloadDiffs: FileDiff[];
  remainingDiffs: FileDiff[];
  errors: string[];
}
