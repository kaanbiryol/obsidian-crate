import { base64ToArrayBuffer } from "./encoding";
import { isHiddenPath } from "./file-discovery";
import { computeHash } from "./hasher";
import { isMarkdownPath } from "./markdown-base-cache";
import { isAbortError } from "./abort";
import type { SyncResult } from "../plugin/types";
import {
	BATCH_DOWNLOAD_MAX_BYTES,
	BATCH_DOWNLOAD_MAX_FILES,
	BATCH_FILE_SIZE_LIMIT,
	MAX_FILE_SIZE_BYTES,
} from "../plugin/types";
import { createLogger, errorMessage } from "../plugin/logger";
import type { TransferContext } from "./transfer-types";
import { isVaultTFileLike } from "./transfer-prepare";
import { createConflictCopy } from "./conflict";

const logger = createLogger("SyncTransfer");

export interface DownloadRequest {
	path: string;
	expectedLocalHash: string | null;
	expectedRemoteHash: string;
	remoteSize: number;
}

async function preserveLocalChangeIfNeeded(
	context: TransferContext,
	request: DownloadRequest,
	result: SyncResult,
): Promise<void> {
	const abstractFile = context.vault.getAbstractFileByPath(request.path);
	const visibleFile = isVaultTFileLike(abstractFile);
	const exists = visibleFile || (isHiddenPath(request.path) && await context.vault.adapter.exists(request.path));
	if (!exists) {
		if (request.expectedLocalHash !== null) {
			throw new Error("Local file was deleted during sync; remote download was skipped");
		}
		return;
	}

	const localContent = await context.vault.adapter.readBinary(request.path);
	const currentHash = await computeHash(localContent);
	if (request.expectedLocalHash === currentHash) return;

	const conflictPath = await createConflictCopy(context.vault, request.path, localContent);
	result.conflicts.push(conflictPath);
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
		throw new Error(`Downloaded content no longer matches the planned remote version for ${path}`);
	}
}

export async function downloadAndSaveFile(
  context: TransferContext,
	request: DownloadRequest,
	result: SyncResult,
): Promise<void> {
	const { path } = request;
	const response = await context.api.downloadFile(path);
	const content = response.content;
  if (content.byteLength > MAX_FILE_SIZE_BYTES) {
    result.errors.push(`${path}: Skipped remote file larger than 25MB`);
		return;
	}
	await validateDownloadedContent(path, content, response.size, response.hash, request.expectedRemoteHash);
	await preserveLocalChangeIfNeeded(context, request, result);

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
	requestsOrPaths: Array<DownloadRequest | string>,
  result: SyncResult,
  concurrency: number,
): Promise<void> {
	const requests = requestsOrPaths.map((request): DownloadRequest => typeof request === 'string'
		? { path: request, expectedLocalHash: null, expectedRemoteHash: '', remoteSize: 0 }
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
					await preserveLocalChangeIfNeeded(context, downloadRequest, result);
					await saveDownloadedContent(context, file.path, content);
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
			await downloadAndSaveFile(context, request, result);
		} catch (error) {
			const downloadError = error instanceof Error ? error.message : "Download failed";
			result.errors.push(`${request.path}: ${downloadError}`);
    }
  });

  await context.runConcurrent(tasks, concurrency);
}
