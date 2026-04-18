import type { Vault } from "obsidian";
import type {
  BatchDownloadResponse,
  BatchUploadFile,
  BatchUploadResponse,
  FileEntry,
  UploadResult,
} from "../plugin/types";

export interface TransferManifest {
  hashMatches(path: string, hash: string): boolean;
  setEntry(path: string, entry: FileEntry): void;
  removeEntry(path: string): void;
}

export interface TransferApi {
  uploadFile(
    path: string,
    content: ArrayBuffer,
    hash: string,
    size: number,
    contentType: string,
  ): Promise<UploadResult>;
  downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number }>;
  deleteFile(path: string): Promise<{ success: boolean; path: string }>;
  batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse>;
  batchDownload(paths: string[]): Promise<BatchDownloadResponse>;
}

export interface TransferContext {
  vault: Vault;
  api: TransferApi;
  localManifest: TransferManifest;
  runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
  retryWithBackoff<T>(fn: () => Promise<T>): Promise<T>;
  getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
}
