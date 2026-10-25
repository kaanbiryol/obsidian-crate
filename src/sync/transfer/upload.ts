import { recordSyncError } from '../issues';
import { isAbortError } from '../abort';
import { arrayBufferToBase64 } from "../encoding";
import { createBatchUploadChunks, prepareUploadFromVaultFile } from "./prepare";
import { isMarkdownPath } from "../merge/markdown-base-cache";
import type { TransferContext } from "./types";
import type { BatchUploadFile, MutationFailure } from '../../protocol/sync-types';
import type { PreparedUpload, SyncResult } from '../types';
import { BATCH_FILE_SIZE_LIMIT } from '../../protocol/sync-limits';
import { createLogger } from "../logger";
import type { VaultFile } from "../local/file-discovery";
import { isVersionConflict } from '../failures';
import { BATCH_UPLOAD_CONCURRENCY, UPLOAD_CONCURRENCY } from './constants';
import { HttpError } from '../worker-api/http';

const logger = createLogger("SyncTransfer");

export async function prepareUploadsFromVaultFiles(
  context: TransferContext,
  files: VaultFile[],
  concurrency: number,
  onPrepared?: (completed: number) => void,
  options?: { force?: boolean },
): Promise<PreparedUpload[]> {
  let completed = 0;

  const tasks = files.map((file) => async () => {
    const uploadFile = await prepareUploadFromVaultFile(context, file, options);
    completed++;
    onPrepared?.(completed);
    return uploadFile;
  });

  const prepared = await context.runConcurrent(tasks, concurrency);
  return prepared.filter((upload): upload is PreparedUpload => upload !== null);
}

type UploadTransferContext = Pick<TransferContext, 'runConcurrent' | 'retryWithBackoff' | 'getModifiedIso'> & {
  files: Pick<TransferContext['files'], 'uploadFile' | 'batchUpload'>;
  localManifest: Pick<TransferContext['localManifest'], 'setEntry'>;
  markdownBaseCache?: Pick<NonNullable<TransferContext['markdownBaseCache']>, 'putBase'>;
};

export async function uploadPreparedFiles(
  context: UploadTransferContext,
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

        const doBatch = () => context.files.batchUpload(files);
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
              recordUploadError(result, `Hash mismatch after upload (expected ${upload.hash}, got ${fileResult.hash})`, upload.path, options);
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
          } else if (isVersionConflict(fileResult.status, fileResult.code)) {
            versionConflictPaths.add(upload.path);
          } else {
            recordUploadError(result, new HttpError(fileResult.error || "Upload failed", fileResult.status ?? 503, null, fileResult.code), upload.path, options);
          }
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        for (const upload of chunk) {
          recordUploadError(result, error, upload.path, options);
        }
      }
      options.onProcessed?.(chunk.length);
    });

    await context.runConcurrent(batchTasks, options.batchConcurrency ?? BATCH_UPLOAD_CONCURRENCY);
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
        // Keep an HTTP status, such as revoked access, for the workflow's outcome.
        for (const path of paths) recordUploadError(result, error instanceof HttpError ? error : `${message}`, path, options);
      }
    } else {
      for (const path of paths) {
        recordUploadError(result, `Remote file changed since it was read`, path, options);
      }
    }
  }
}

export interface UploadPreparedFilesOptions {
  concurrency?: number;
  retry: boolean;
  batchConcurrency?: number;
  onProcessed?: (count: number) => void;
  onFailure?: (failure: MutationFailure) => void;
  onVersionConflicts?: (paths: string[], result: SyncResult) => Promise<void>;
}

async function uploadPreparedFilesIndividually(
  context: UploadTransferContext,
  prepared: PreparedUpload[],
  result: SyncResult,
  options: Pick<UploadPreparedFilesOptions, 'concurrency' | 'retry' | 'onProcessed' | 'onFailure'>,
): Promise<string[]> {
  const tasks = prepared.map((upload) => async () => {
    try {
      const doUpload = () => context.files.uploadFile(
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
          recordUploadError(result, `Hash mismatch after upload (expected ${upload.hash}, got ${uploadResult.hash})`, upload.path, options);
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

      if (isVersionConflict(uploadResult.status, uploadResult.code)) {
        return upload.path;
      }
      recordUploadError(result, new HttpError(uploadResult.error || "Upload failed", uploadResult.status ?? 503, null, uploadResult.code), upload.path, options);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof HttpError && isVersionConflict(error.status, error.code)) {
        return upload.path;
      }
      recordUploadError(result, error, upload.path, options);
    } finally {
      options.onProcessed?.(1);
    }
    return null;
  });

  const versionConflicts = await context.runConcurrent(tasks, options.concurrency ?? UPLOAD_CONCURRENCY);
  return versionConflicts.filter((path): path is string => path !== null);
}

function recordUploadError(result: SyncResult, error: unknown, path: string, options: Pick<UploadPreparedFilesOptions, 'onFailure'>): void {
  recordSyncError(result, error, path);
  options.onFailure?.({
    path,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof HttpError ? { status: error.status, code: error.code as MutationFailure['code'] } : {}),
  });
}
