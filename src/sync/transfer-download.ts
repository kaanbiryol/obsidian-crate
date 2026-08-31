import { isAbortError } from "./abort";
import { base64ToArrayBuffer } from "./encoding";
import { computeHash } from "./hasher";
import { applyRemoteContentIfUnchanged, writeRemoteContent } from "./local-apply";
import { isMarkdownPath } from "./markdown-base-cache";
import type { DiffApplyOutcome, TransferContext } from "./transfer-types";
import { createLogger, errorMessage } from "../plugin/logger";
import type { FileEntry, SyncResult } from "../plugin/types";
import {
  BATCH_DOWNLOAD_MAX_BYTES,
  BATCH_DOWNLOAD_MAX_FILES,
  BATCH_FILE_SIZE_LIMIT,
  MAX_FILE_SIZE_BYTES,
} from "../plugin/types";

const logger = createLogger("SyncTransfer");

export interface DownloadRequest {
  path: string;
  expectedLocalHash: string | null;
  expectedRemoteHash: string;
  remoteSize: number;
}

export class RemoteVersionChangedError extends Error {
  constructor(path: string) {
    super(`Downloaded content no longer matches the planned remote version for ${path}`);
    this.name = "RemoteVersionChangedError";
  }
}

export async function validateDownloadedContent(
  path: string,
  content: ArrayBuffer,
  declaredSize: number,
  declaredHash: string,
  expectedRemoteHash: string,
): Promise<void> {
  if (declaredSize !== content.byteLength) {
    throw new Error(`Download size mismatch (expected ${declaredSize}, got ${content.byteLength})`);
  }
  const computedHash = await computeHash(content);
  if (declaredHash && declaredHash !== computedHash) {
    throw new Error(`Download hash mismatch for ${path}`);
  }
  if (expectedRemoteHash && expectedRemoteHash !== computedHash) {
    throw new RemoteVersionChangedError(path);
  }
}

export async function downloadAndSaveFile(
  context: TransferContext,
  request: DownloadRequest,
  result: SyncResult,
): Promise<DiffApplyOutcome> {
  const { path } = request;
  const response = await context.api.downloadFile(path);
  const content = response.content;
  if (content.byteLength > MAX_FILE_SIZE_BYTES) {
    return { status: "deferred", reason: "Skipped remote file larger than 25MB" };
  }
  await validateDownloadedContent(path, content, response.size, response.hash, request.expectedRemoteHash);
  const outcome = await applyRemoteContentIfUnchanged(context, path, content, request.expectedLocalHash);
  if (outcome.status === "deferred") return outcome;

  await recordDownloadedContent(context, path, content);
  result.downloaded++;
  result.downloadedPaths.push(path);
  return { status: "applied" };
}

export async function saveDownloadedContent(
  context: TransferContext,
  path: string,
  content: ArrayBuffer,
): Promise<FileEntry> {
  if (content.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error("Skipped remote file larger than 25MB");
  }

  await writeRemoteContent(context, path, content);
  return recordDownloadedContent(context, path, content);
}

async function recordDownloadedContent(
  context: TransferContext,
  path: string,
  content: ArrayBuffer,
): Promise<FileEntry> {
  const hash = await computeHash(content);
  const entry: FileEntry = {
    hash,
    size: content.byteLength,
    modified: await context.getModifiedIso(path),
  };
  context.localManifest.setEntry(path, entry);

  if (isMarkdownPath(path)) {
    await context.markdownBaseCache?.putBase(path, hash, content);
  }
  return entry;
}

export async function parallelDownloadAndSaveFiles(
  context: TransferContext,
  requestsOrPaths: Array<DownloadRequest | string>,
  result: SyncResult,
  concurrency: number,
): Promise<void> {
  const requests = requestsOrPaths.map((request): DownloadRequest => typeof request === "string"
    ? { path: request, expectedLocalHash: null, expectedRemoteHash: "", remoteSize: 0 }
    : request);
  const batchable: DownloadRequest[] = [];
  const individual: DownloadRequest[] = [];

  for (const request of requests) {
    if (request.remoteSize < BATCH_FILE_SIZE_LIMIT) batchable.push(request);
    else individual.push(request);
  }

  if (batchable.length > 0) {
    const chunks: DownloadRequest[][] = [];
    let currentChunk: DownloadRequest[] = [];
    let currentBytes = 0;
    for (const request of batchable) {
      if (
        currentChunk.length >= BATCH_DOWNLOAD_MAX_FILES
        || (currentChunk.length > 0 && currentBytes + request.remoteSize > BATCH_DOWNLOAD_MAX_BYTES)
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }
      currentChunk.push(request);
      currentBytes += request.remoteSize;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    for (const chunk of chunks) {
      try {
        const response = await context.api.batchDownload(chunk.map((request) => request.path));
        const requestsByPath = new Map(chunk.map((request) => [request.path, request] as const));
        const responsePaths = response.files.map((file) => file.path);
        if (
          new Set(responsePaths).size !== responsePaths.length
          || responsePaths.length !== chunk.length
          || responsePaths.some((path) => !requestsByPath.has(path))
        ) {
          throw new Error("Batch download response did not match the requested paths");
        }

        const seenPaths = new Set<string>();
        for (const file of response.files) {
          try {
            const downloadRequest = requestsByPath.get(file.path);
            if (!downloadRequest) throw new Error("Unexpected path in batch response");
            seenPaths.add(file.path);
            if (file.error) {
              result.errors.push(`${file.path}: ${file.error}`);
              continue;
            }

            const content = base64ToArrayBuffer(file.content);
            await validateDownloadedContent(
              file.path,
              content,
              file.size,
              file.hash,
              downloadRequest.expectedRemoteHash,
            );
            const outcome = await applyRemoteContentIfUnchanged(
              context,
              file.path,
              content,
              downloadRequest.expectedLocalHash,
            );
            if (outcome.status === "deferred") {
              result.errors.push(`${file.path}: ${outcome.reason}`);
              continue;
            }
            await recordDownloadedContent(context, file.path, content);
            result.downloaded++;
            result.downloadedPaths.push(file.path);
          } catch (error) {
            const downloadError = error instanceof Error ? error.message : "Download failed";
            result.errors.push(`${file.path}: ${downloadError}`);
          }
        }
        for (const request of chunk) {
          if (!seenPaths.has(request.path)) {
            result.errors.push(`${request.path}: Missing from batch download response`);
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        logger.warn("Batch download failed, falling back to individual downloads:", errorMessage(error));
        individual.push(...chunk);
      }
    }
  }

  if (individual.length > 0) {
    await downloadFilesIndividually(context, individual, result, concurrency);
  }
}

async function downloadFilesIndividually(
  context: TransferContext,
  requests: DownloadRequest[],
  result: SyncResult,
  concurrency: number,
): Promise<void> {
  const tasks = requests.map((request) => async () => {
    try {
      const outcome = await downloadAndSaveFile(context, request, result);
      if (outcome.status === "deferred") {
        result.errors.push(`${request.path}: ${outcome.reason}`);
      }
    } catch (error) {
      const downloadError = error instanceof Error ? error.message : "Download failed";
      result.errors.push(`${request.path}: ${downloadError}`);
    }
  });

  await context.runConcurrent(tasks, concurrency);
}
