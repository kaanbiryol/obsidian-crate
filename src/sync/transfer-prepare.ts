import type { TFile } from "obsidian";
import { computeHash } from "./hasher";
import { getExtensionFromPath, isHiddenPath, tfileToVaultFile } from "./file-discovery";
import type { VaultFile } from "./file-discovery";
import type { PreparedUpload } from "../plugin/types";
import { BATCH_MAX_BYTES, BATCH_MAX_FILES, MAX_FILE_SIZE_BYTES } from "../plugin/types";
import { createLogger } from "../plugin/logger";
import type { TransferContext } from "./transfer-types";

const logger = createLogger("SyncTransfer");

export function isVaultTFileLike(file: unknown): file is TFile {
  return typeof file === "object"
    && file !== null
    && "path" in file
    && typeof file.path === "string"
    && "extension" in file
    && typeof file.extension === "string";
}

export async function prepareUpload(
  context: TransferContext,
  file: TFile,
): Promise<PreparedUpload | null> {
  return prepareUploadFromVaultFile(context, tfileToVaultFile(file));
}

export async function prepareUploadFromVaultFile(
  context: TransferContext,
  file: VaultFile,
  options?: { force?: boolean },
): Promise<PreparedUpload | null> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    logger.warn("Skipping large file:", file.path);
    return null;
  }

  const content = await context.vault.adapter.readBinary(file.path);
  const hash = await computeHash(content);

  if (!options?.force && context.localManifest.hashMatches(file.path, hash)) {
    logger.debug("Skipping unchanged file:", file.path);
    return null;
  }

  return {
    path: file.path,
    content,
    hash,
    size: file.size,
    mtime: file.mtime,
    contentType: getContentType(file.extension),
  };
}

export async function prepareUploadFromPath(
  context: TransferContext,
  path: string,
  options?: { force?: boolean },
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

export function createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][] {
  if (files.length === 0) {
    return [];
  }

  const chunks: VaultFile[][] = [];
  for (let index = 0; index < files.length; index += chunkSize) {
    chunks.push(files.slice(index, index + chunkSize));
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
