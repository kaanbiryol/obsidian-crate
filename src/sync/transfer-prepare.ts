import { computeHash } from "./hasher";
import { getExtensionFromPath, isHiddenPath, tfileToVaultFile } from "./file-discovery";
import { isVaultTFileLike } from './planner-helpers';
import type { VaultFile } from "./file-discovery";
import type { PreparedUpload } from './types';
import {
	BATCH_UPLOAD_MAX_BYTES as BATCH_MAX_BYTES,
	BATCH_UPLOAD_MAX_FILES as BATCH_MAX_FILES,
	MAX_FILE_SIZE_BYTES,
} from '../protocol/sync-limits';
import { createLogger } from "../plugin/logger";
import type { TransferContext } from "./transfer-types";

const logger = createLogger("SyncTransfer");

export async function prepareUploadFromVaultFile(
  context: TransferContext,
  file: VaultFile,
  options?: { force?: boolean; expectedHash?: string | null },
): Promise<PreparedUpload | null> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    logger.warn("Skipping large file:", file.path);
    throw new Error("Skipped local file larger than 25MB; this file is not synced");
  }

  let source = file;
  let content = await context.vault.adapter.readBinary(file.path);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (content.byteLength > MAX_FILE_SIZE_BYTES) {
      logger.warn("Skipping large file:", file.path);
      throw new Error("Skipped local file larger than 25MB; this file is not synced");
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

  const hash = await computeHash(content);

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

  const stat = await context.vault.adapter.stat(path);
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

export function createBatchUploadChunks(prepared: PreparedUpload[]): PreparedUpload[][] {
  const chunks: PreparedUpload[][] = [];
  let currentChunk: PreparedUpload[] = [];
  let currentBytes = 0;

  for (const upload of prepared) {
    if (
      currentChunk.length >= BATCH_MAX_FILES
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

  return types[extension.toLowerCase()] || "application/octet-stream";
}
