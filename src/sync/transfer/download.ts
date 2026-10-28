import { recordSyncError } from '../issues';
import { isAbortError } from "../abort";
import { base64ToArrayBuffer } from "../encoding";
import { applyRemoteContentIfUnchanged, incomingReviewMessage } from "../local/local-apply";
import { unsupportedLocalPathIssue } from '../local/local-path-safety';
import { recordAppliedContent } from './applied-content';
import type { DiffApplyOutcome, TransferContext } from "./types";
import { createLogger } from "../logger";
import { errorMessage } from "../../platform/logger";
import type { SyncResult } from '../types';
import type { MutationFailure } from '../../protocol/sync-types';
import { fileFailure, isAuthError, isTransientSyncFailure } from '../failures';
import { BATCH_DOWNLOAD_MAX_BYTES, BATCH_DOWNLOAD_MAX_FILES, BATCH_FILE_SIZE_LIMIT, MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { sha256Hex } from '../../platform/sha256';

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
	// Decryption already verified these bytes against `declaredHash`.
	verified = false,
): Promise<string> {
	if (declaredSize !== content.byteLength) {
		throw new Error(`Download size mismatch (expected ${declaredSize}, got ${content.byteLength})`);
	}
	const computedHash = verified ? declaredHash : await sha256Hex(content);
	if (declaredHash && declaredHash !== computedHash) {
		throw new Error(`Download hash mismatch for ${path}`);
	}
	if (expectedRemoteHash && expectedRemoteHash !== computedHash) {
		throw new RemoteVersionChangedError(path);
	}
	return computedHash;
}

export async function downloadAndSaveFile(
	context: TransferContext,
	request: DownloadRequest,
	result: SyncResult,
): Promise<DiffApplyOutcome> {
	const { path } = request;
	const response = await context.files.downloadFile(path, request.remoteSize);
	const content = response.content;
	if (content.byteLength > MAX_FILE_SIZE_BYTES) {
		return { status: "deferred", reason: "Skipped remote file larger than 25MB" };
	}
	const hash = await validateDownloadedContent(path, content, response.size, response.hash, request.expectedRemoteHash, response.verified);
	const outcome = await applyRemoteContentIfUnchanged(context, path, content, request.expectedLocalHash);
	if (outcome.status === "deferred") return outcome;

	await recordAppliedContent(context, path, content, response.revision, hash);
	result.downloaded++;
	result.downloadedPaths.push(path);
	return { status: "applied" };
}

/** A version already saved for review is not downloaded again only to save the same copy. */
async function awaitingReview(context: TransferContext, request: DownloadRequest): Promise<string | null> {
	if (request.expectedLocalHash === null) return null;
	const review = context.conflictStore.findIncomingReview(request.path, request.expectedRemoteHash, request.expectedLocalHash);
	return review && await context.vault.adapter.exists(review.conflictPath) ? incomingReviewMessage(review.conflictPath) : null;
}

export async function parallelDownloadAndSaveFiles(
	context: TransferContext,
	requests: DownloadRequest[],
	result: SyncResult,
	concurrency: number,
	onProcessed?: () => void,
	onFailure?: (failure: MutationFailure) => void,
): Promise<void> {
	const batchable: DownloadRequest[] = [];
	const individual: DownloadRequest[] = [];
	let stopped: unknown;
	const failRequests = (failed: readonly DownloadRequest[], error: unknown) => {
		for (const request of failed) {
			recordSyncError(result, error, request.path);
			onFailure?.(fileFailure(request.path, error));
			onProcessed?.();
		}
	};

	for (const request of requests) {
		const unsupported = unsupportedLocalPathIssue(request.path);
		if (unsupported) {
			(result.issues ??= []).push(unsupported);
			onProcessed?.();
			continue;
		}
		const review = await awaitingReview(context, request);
		if (review) {
			recordSyncError(result, review, request.path);
			onProcessed?.();
		} else if (request.remoteSize < BATCH_FILE_SIZE_LIMIT) batchable.push(request);
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

		await context.runConcurrent(chunks.map(chunk => async () => {
			if (stopped !== undefined) return failRequests(chunk, stopped);
			try {
				const response = await context.files.batchDownload(chunk.map((request) => request.path));
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
							recordSyncError(result, `${file.error}`, file.path);
							continue;
						}

						const verified = "verifiedContent" in file;
						const content = verified ? file.verifiedContent : base64ToArrayBuffer(file.content);
						const hash = await validateDownloadedContent(
							file.path,
							content,
							file.size,
							file.hash,
							downloadRequest.expectedRemoteHash,
							verified,
						);
						const outcome = await applyRemoteContentIfUnchanged(
							context,
							file.path,
							content,
							downloadRequest.expectedLocalHash,
						);
						if (outcome.status === "deferred") {
							recordSyncError(result, `${outcome.reason}`, file.path);
							continue;
						}
						await recordAppliedContent(context, file.path, content, file.revision, hash);
						result.downloaded++;
						result.downloadedPaths.push(file.path);
					} catch (error) {
						if (isAbortError(error)) throw error;
						const downloadError = error instanceof Error ? error.message : "Download failed";
						recordSyncError(result, `${downloadError}`, file.path);
						onFailure?.(fileFailure(file.path, error));
					} finally {
						onProcessed?.();
					}
				}
				for (const request of chunk) {
					if (!seenPaths.has(request.path)) {
						recordSyncError(result, `Missing from batch download response`, request.path);
					}
				}
			} catch (error) {
				if (isAbortError(error)) {
					throw error;
				}
				// A timeout, busy server or revoked access would fail one request per file
				// the same way, so stop as delete batches do. Only a malformed response or
				// another refusal falls back to individual downloads.
				if (isTransientSyncFailure(error) || isAuthError(error)) {
					stopped = error;
					return failRequests(chunk, error);
				}

				logger.warn("Batch download failed, falling back to individual downloads:", errorMessage(error));
				individual.push(...chunk);
			}
		}), Math.min(concurrency, 2));
	}

	if (individual.length > 0) {
		if (stopped !== undefined) failRequests(individual, stopped);
		else await downloadFilesIndividually(context, individual, result, concurrency, onProcessed, onFailure);
	}
}

async function downloadFilesIndividually(
	context: TransferContext,
	requests: DownloadRequest[],
	result: SyncResult,
	concurrency: number,
	onProcessed?: () => void,
	onFailure?: (failure: MutationFailure) => void,
): Promise<void> {
	const tasks = requests.map((request) => async () => {
		try {
			const outcome = await downloadAndSaveFile(context, request, result);
			if (outcome.status === "deferred") {
				recordSyncError(result, `${outcome.reason}`, request.path);
			}
		} catch (error) {
			if (isAbortError(error)) throw error;
			const downloadError = error instanceof Error ? error.message : "Download failed";
			recordSyncError(result, `${downloadError}`, request.path);
			onFailure?.(fileFailure(request.path, error));
		} finally {
			onProcessed?.();
		}
	});

	await context.runConcurrent(tasks, concurrency);
}
