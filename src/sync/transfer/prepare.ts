import { SkippedFileError, withSyncFileContext } from '../issues';
import { getExtensionFromPath, isHiddenPath, tfileToVaultFile } from "../local/file-discovery";
import { isVaultTFileLike } from '../local/local-delete';
import type { VaultFile } from "../local/file-discovery";
import type { PreparedUpload } from '../types';
import {
	BATCH_UPLOAD_MAX_BYTES as BATCH_MAX_BYTES,
	MAX_FILE_SIZE_BYTES,
	maxUploadBatchFiles,
} from '../../protocol/sync-limits';
import { createLogger } from "../logger";
import type { TransferContext } from "./types";
import { sha256Hex } from '../../platform/sha256';

const logger = createLogger("SyncTransfer");

export async function prepareUploadFromVaultFile(
  context: TransferContext,
  file: VaultFile,
  options?: { force?: boolean; expectedHash?: string | null },
): Promise<PreparedUpload | null> {
  return withSyncFileContext(file.path, async () => {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      logger.warn("Skipping large file:", file.path);
      throw new SkippedFileError(file.path);
    }

    let source = file;
    let content = await context.vault.adapter.readBinary(file.path);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (content.byteLength > MAX_FILE_SIZE_BYTES) {
        logger.warn("Skipping large file:", file.path);
        throw new SkippedFileError(file.path);
      }

      const stat = await context.vault.adapter.stat(file.path);
      if (!stat || stat.type !== "file") {
        throw new Error(`File disappeared while preparing upload: ${file.path}`);
      }
      if (stat.size === content.byteLength && stat.mtime === source.mtime) {
        source = { ...source, size: content.byteLength, mtime: stat.mtime };
        break;
      }
      if (attempt === 1) {
        throw new Error(`File changed repeatedly while preparing upload: ${file.path}`);
      }

      source = { ...source, size: stat.size, mtime: stat.mtime };
      content = await context.vault.adapter.readBinary(file.path);
    }

    const hash = context.plannedContent
      ? await context.plannedContent.hash(file.path, content)
      : await sha256Hex(content);

    if (!options?.force && context.localManifest.hashMatches(file.path, hash)) {
      context.localManifest.setEntry(file.path, {
        hash,
        size: content.byteLength,
        modified: new Date(source.mtime).toISOString(),
      });
      logger.debug("Skipping unchanged file:", file.path);
      return null;
    }

    return {
      path: file.path,
      content,
      hash,
      size: content.byteLength,
      mtime: source.mtime,
      contentType: getContentType(file.extension),
      expectedHash: options && 'expectedHash' in options
        ? options.expectedHash ?? null
        : context.localManifest.getEntry?.(file.path)?.hash ?? null,
    };
  });
}

export async function prepareUploadFromPath(
  context: TransferContext,
  path: string,
  options?: { force?: boolean; expectedHash?: string | null },
): Promise<PreparedUpload | null> {
  const file = context.vault.getAbstractFileByPath(path);
  if (isVaultTFileLike(file)) {
    return prepareUploadFromVaultFile(context, tfileToVaultFile(file), options);
  }

  if (!isHiddenPath(path)) {
    return null;
  }

  const stat = await withSyncFileContext(path, () => context.vault.adapter.stat(path));
  if (!stat || stat.type !== "file") {
    return null;
  }

  return prepareUploadFromVaultFile(context, {
    path,
    size: stat.size,
    mtime: stat.mtime,
    extension: getExtensionFromPath(path),
  }, options);
}

/** Chunks are planned before the transport resolves the server's capabilities or
 * the vault's encryption, so new files are treated as bulk eligible here.
 * `SyncWorkerApi.batchUpload` applies the same rule with the actual eligibility and
 * splits a chunk the server cannot accept in one request. */
export function createBatchUploadChunks(prepared: PreparedUpload[]): PreparedUpload[][] {
  const chunks: PreparedUpload[][] = [];
  let currentChunk: PreparedUpload[] = [];
  let currentBytes = 0;

  for (const upload of prepared) {
    if (
      currentChunk.length >= maxUploadBatchFiles([...currentChunk, upload], true)
      || (currentChunk.length > 0 && currentBytes + upload.size > BATCH_MAX_BYTES)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }

    currentChunk.push(upload);
    currentBytes += upload.size;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function getContentType(extension: string): string {
  const types: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    css: "text/css",
    js: "application/javascript",
    ts: "application/typescript",
    html: "text/html",
    xml: "application/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
  };

  const key = extension.toLowerCase();
  return Object.prototype.hasOwnProperty.call(types, key) ? types[key]! : "application/octet-stream";
}
