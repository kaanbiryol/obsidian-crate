import { base64ToArrayBuffer } from "./encoding";
import { isHiddenPath } from "./file-discovery";
import { computeHash } from "./hasher";
import { isMarkdownPath } from "./markdown-base-cache";
import { isAbortError } from "./abort";
import type { SyncResult } from "../plugin/types";
import { BATCH_MAX_FILES, MAX_FILE_SIZE_BYTES } from "../plugin/types";
import { createLogger, errorMessage } from "../plugin/logger";
import type { TransferContext } from "./transfer-types";
import { isVaultTFileLike } from "./transfer-prepare";

const logger = createLogger("SyncTransfer");

export async function downloadAndSaveFile(
  context: TransferContext,
  path: string,
  result: SyncResult,
): Promise<void> {
  const response = await context.api.downloadFile(path);
  const content = response.content;
  if (content.byteLength > MAX_FILE_SIZE_BYTES) {
    result.errors.push(`${path}: Skipped remote file larger than 25MB`);
    return;
  }

  await saveDownloadedContent(context, path, content);
  result.downloaded++;
  result.downloadedPaths.push(path);
}

export async function saveDownloadedContent(
  context: TransferContext,
  path: string,
  content: ArrayBuffer,
): Promise<void> {
  if (content.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error("Skipped remote file larger than 25MB");
  }

  const folderPath = path.substring(0, path.lastIndexOf("/"));
  if (folderPath) {
    if (isHiddenPath(path)) {
      try {
        await context.vault.adapter.mkdir(folderPath);
      } catch {
        // Folder already exists.
      }
    } else {
      try {
        await context.vault.createFolder(folderPath);
      } catch {
        // Folder already exists.
      }
    }
  }

  if (isHiddenPath(path)) {
    await context.vault.adapter.writeBinary(path, content);
  } else {
    const existingFile = context.vault.getAbstractFileByPath(path);
    if (existingFile && !isVaultTFileLike(existingFile)) {
      throw new Error(`Cannot overwrite non-file path: ${path}`);
    }
    if (existingFile) {
      await context.vault.modifyBinary(existingFile, content);
    } else {
      await context.vault.createBinary(path, content);
    }
  }

  const hash = await computeHash(content);
  const entry = {
    hash,
    size: content.byteLength,
    modified: await context.getModifiedIso(path),
  };
  context.localManifest.setEntry(path, entry);

  if (isMarkdownPath(path)) {
    await context.markdownBaseCache?.putBase(path, hash, content);
  }
}

export async function parallelDownloadAndSaveFiles(
  context: TransferContext,
  paths: string[],
  result: SyncResult,
  concurrency: number,
): Promise<void> {
  const batchable: string[] = [];
  const individual: string[] = [];

  for (const path of paths) {
    batchable.push(path);
  }

  if (batchable.length > 0) {
    const chunks: string[][] = [];
    for (let index = 0; index < batchable.length; index += BATCH_MAX_FILES) {
      chunks.push(batchable.slice(index, index + BATCH_MAX_FILES));
    }

    for (const chunk of chunks) {
      try {
        const response = await context.api.batchDownload(chunk);
        for (const file of response.files) {
          try {
            if (file.error) {
              result.errors.push(`${file.path}: ${file.error}`);
              continue;
            }

            const content = base64ToArrayBuffer(file.content);
            await saveDownloadedContent(context, file.path, content);
            result.downloaded++;
            result.downloadedPaths.push(file.path);
          } catch (error) {
            const downloadError = error instanceof Error ? error.message : "Download failed";
            result.errors.push(`${file.path}: ${downloadError}`);
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
  paths: string[],
  result: SyncResult,
  concurrency: number,
): Promise<void> {
  const tasks = paths.map((path) => async () => {
    try {
      await downloadAndSaveFile(context, path, result);
    } catch (error) {
      const downloadError = error instanceof Error ? error.message : "Download failed";
      result.errors.push(`${path}: ${downloadError}`);
    }
  });

  await context.runConcurrent(tasks, concurrency);
}
