import { isAbortError } from './abort';
import { arrayBufferToBase64 } from "./encoding";
import { createBatchUploadChunks, prepareUploadFromVaultFile } from "./transfer-prepare";
import { isMarkdownPath } from "./markdown-base-cache";
import type { TransferContext } from "./transfer-types";
import type { BatchUploadFile } from '../protocol/sync-types';
import type { PreparedUpload, SyncResult } from './types';
import { BATCH_FILE_SIZE_LIMIT } from '../protocol/sync-limits';
import { createLogger } from "../plugin/logger";
import type { VaultFile } from "./file-discovery";
import { HttpError } from './api';
import { isQueueVersionConflict } from './queue-failure';

const logger = createLogger("SyncTransfer");

export async function prepareUploadsFromVaultFiles(
  context: TransferContext,
  files: VaultFile[],
  concurrency: number,
  onPrepared?: (completed: number) => void,
): Promise<PreparedUpload[]> {
  let completed = 0;

  const tasks = files.map((file) => async () => {
    const uploadFile = await prepareUploadFromVaultFile(context, file);
    completed++;
    onPrepared?.(completed);
    return uploadFile;
  });

  const prepared = await context.runConcurrent(tasks, concurrency);
  return prepared.filter((upload): upload is PreparedUpload => upload !== null);
}

export async function uploadPreparedFiles(
  context: TransferContext,
  prepared: PreparedUpload[],
  result: SyncResult,
  options: UploadPreparedFilesOptions,
): Promise<void> {
  if (prepared.length === 0) {
    return;
  }

  logger.info(`Uploading ${prepared.length} files`);

  const batchable = prepared.filter((file) => file.size < BATCH_FILE_SIZE_LIMIT);
  const individual = prepared.filter((file) => file.size >= BATCH_FILE_SIZE_LIMIT);
  const versionConflictPaths = new Set<string>();

  if (batchable.length > 0) {
    const chunks = createBatchUploadChunks(batchable);
    const batchTasks = chunks.map((chunk) => async () => {
      try {
        const files: BatchUploadFile[] = chunk.map((upload) => ({
          path: upload.path,
          content: arrayBufferToBase64(upload.content),
          hash: upload.hash,
          size: upload.size,
          contentType: upload.contentType || "application/octet-stream",
          expectedHash: upload.expectedHash ?? null,
        }));

        const doBatch = () => context.api.batchUpload(files);
        const response = options.retry
          ? await context.retryWithBackoff(doBatch)
          : await doBatch();
        const expectedPaths = new Set(chunk.map((upload) => upload.path));
        const responsePaths = response.results.map((file) => file.path);
        if (
          new Set(responsePaths).size !== responsePaths.length
          || responsePaths.length !== chunk.length
          || responsePaths.some((path) => !expectedPaths.has(path))
        ) {
          throw new Error("Batch upload response did not match the requested paths");
        }

        for (const fileResult of response.results) {
          const upload = chunk.find((candidate) => candidate.path === fileResult.path);
          if (!upload) {
            continue;
          }

          if (fileResult.success) {
            if (fileResult.hash && fileResult.hash !== upload.hash) {
              result.errors.push(
                `${upload.path}: Hash mismatch after upload (expected ${upload.hash}, got ${fileResult.hash})`,
              );
              continue;
            }

            result.uploaded++;
            result.uploadedPaths.push(upload.path);
            context.localManifest.setEntry(upload.path, {
              hash: upload.hash,
              revision: fileResult.revision,
              size: upload.size,
              modified: await context.getModifiedIso(upload.path, upload.mtime),
            });
            if (isMarkdownPath(upload.path)) {
              await context.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
            }
          } else if (fileResult.code === 'version_conflict' || isQueueVersionConflict(fileResult.status, fileResult.code)) {
            versionConflictPaths.add(upload.path);
          } else {
            result.errors.push(`${upload.path}: ${fileResult.error || "Upload failed"}`);
          }
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        const uploadError = error instanceof Error ? error.message : "Batch upload failed";
        for (const upload of chunk) {
          result.errors.push(`${upload.path}: ${uploadError}`);
        }
      }
    });

    await context.runConcurrent(batchTasks, options.batchConcurrency ?? 1);
  }

  if (individual.length > 0) {
    const individualConflicts = await uploadPreparedFilesIndividually(context, individual, result, options);
    for (const path of individualConflicts) versionConflictPaths.add(path);
  }

  if (versionConflictPaths.size > 0) {
    const paths = [...versionConflictPaths];
    if (options.onVersionConflicts) {
      try {
        await options.onVersionConflicts(paths, result);
      } catch (error) {
        if (isAbortError(error)) throw error;
        const message = error instanceof Error ? error.message : 'Version-conflict reconciliation failed';
        for (const path of paths) result.errors.push(`${path}: ${message}`);
      }
    } else {
      for (const path of paths) {
        result.errors.push(`${path}: Remote file changed since it was read`);
      }
    }
  }
}

export interface UploadPreparedFilesOptions {
  concurrency: number;
  retry: boolean;
  batchConcurrency?: number;
  onVersionConflicts?: (paths: string[], result: SyncResult) => Promise<void>;
}

async function uploadPreparedFilesIndividually(
  context: TransferContext,
  prepared: PreparedUpload[],
  result: SyncResult,
  options: Pick<UploadPreparedFilesOptions, 'concurrency' | 'retry'>,
): Promise<string[]> {
  const tasks = prepared.map((upload) => async () => {
    try {
      const doUpload = () => context.api.uploadFile(
        upload.path,
        upload.content,
        upload.hash,
        upload.size,
        upload.contentType || "application/octet-stream",
        upload.expectedHash ?? null,
      );
      const uploadResult = options.retry
        ? await context.retryWithBackoff(doUpload)
        : await doUpload();

      if (uploadResult.success) {
        if (uploadResult.hash && uploadResult.hash !== upload.hash) {
          result.errors.push(
            `${upload.path}: Hash mismatch after upload (expected ${upload.hash}, got ${uploadResult.hash})`,
          );
          return null;
        }

        result.uploaded++;
        result.uploadedPaths.push(upload.path);
        context.localManifest.setEntry(upload.path, {
          hash: upload.hash,
          revision: uploadResult.revision,
          size: upload.size,
          modified: await context.getModifiedIso(upload.path, upload.mtime),
        });
        if (isMarkdownPath(upload.path)) {
          await context.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
        }
        return null;
      }

      if (uploadResult.code === 'version_conflict' || isQueueVersionConflict(uploadResult.status, uploadResult.code)) {
        return upload.path;
      }
      result.errors.push(`${upload.path}: ${uploadResult.error || "Upload failed"}`);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof HttpError && isQueueVersionConflict(error.status, error.code)) {
        return upload.path;
      }
      const uploadError = error instanceof Error ? error.message : "Upload failed";
      result.errors.push(`${upload.path}: ${uploadError}`);
    }
    return null;
  });

  const versionConflicts = await context.runConcurrent(tasks, options.concurrency);
  return versionConflicts.filter((path): path is string => path !== null);
}
