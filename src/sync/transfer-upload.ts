import { arrayBufferToBase64 } from "./encoding";
import { createBatchUploadChunks, prepareUploadFromVaultFile } from "./transfer-prepare";
import type { TransferContext } from "./transfer-types";
import type { BatchUploadFile, PreparedUpload, SyncResult } from "../plugin/types";
import { BATCH_FILE_SIZE_LIMIT } from "../plugin/types";
import { createLogger } from "../plugin/logger";
import type { VaultFile } from "./file-discovery";

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
  options: { concurrency: number; retry: boolean; batchConcurrency?: number },
): Promise<void> {
  if (prepared.length === 0) {
    return;
  }

  logger.info(`Uploading ${prepared.length} files`);

  const batchable = prepared.filter((file) => file.size < BATCH_FILE_SIZE_LIMIT);
  const individual = prepared.filter((file) => file.size >= BATCH_FILE_SIZE_LIMIT);

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
        }));

        const doBatch = () => context.api.batchUpload(files);
        const response = options.retry
          ? await context.retryWithBackoff(doBatch)
          : await doBatch();

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
              size: upload.size,
              modified: await context.getModifiedIso(upload.path, upload.mtime),
            });
          } else {
            result.errors.push(`${upload.path}: ${fileResult.error || "Upload failed"}`);
          }
        }
      } catch (error) {
        const uploadError = error instanceof Error ? error.message : "Batch upload failed";
        for (const upload of chunk) {
          result.errors.push(`${upload.path}: ${uploadError}`);
        }
      }
    });

    await context.runConcurrent(batchTasks, options.batchConcurrency ?? 1);
  }

  if (individual.length > 0) {
    await uploadPreparedFilesIndividually(context, individual, result, options);
  }
}

async function uploadPreparedFilesIndividually(
  context: TransferContext,
  prepared: PreparedUpload[],
  result: SyncResult,
  options: { concurrency: number; retry: boolean },
): Promise<void> {
  const tasks = prepared.map((upload) => async () => {
    try {
      const doUpload = () => context.api.uploadFile(
        upload.path,
        upload.content,
        upload.hash,
        upload.size,
        upload.contentType || "application/octet-stream",
      );
      const uploadResult = options.retry
        ? await context.retryWithBackoff(doUpload)
        : await doUpload();

      if (uploadResult.success) {
        if (uploadResult.hash && uploadResult.hash !== upload.hash) {
          result.errors.push(
            `${upload.path}: Hash mismatch after upload (expected ${upload.hash}, got ${uploadResult.hash})`,
          );
          return;
        }

        result.uploaded++;
        result.uploadedPaths.push(upload.path);
        context.localManifest.setEntry(upload.path, {
          hash: upload.hash,
          size: upload.size,
          modified: await context.getModifiedIso(upload.path, upload.mtime),
        });
        return;
      }

      result.errors.push(`${upload.path}: ${uploadResult.error || "Upload failed"}`);
    } catch (error) {
      const uploadError = error instanceof Error ? error.message : "Upload failed";
      result.errors.push(`${upload.path}: ${uploadError}`);
    }
  });

  await context.runConcurrent(tasks, options.concurrency);
}
