import type { TFile, Vault } from 'obsidian';
import { computeHash } from './hasher';
import { createConflictCopy } from './conflict';
import { getExtensionFromPath, isHiddenPath, tfileToVaultFile } from './file-discovery';
import type { VaultFile } from './file-discovery';
import { createLogger } from '../logger';
import { arrayBufferToBase64, base64ToArrayBuffer } from './encoding';
import type { BatchUploadFile, BatchUploadResponse, BatchDownloadResponse, FileDiff, FileEntry, PreparedUpload, SyncResult, UploadResult } from '../types';
import { BATCH_FILE_SIZE_LIMIT, BATCH_MAX_BYTES, BATCH_MAX_FILES, MAX_FILE_SIZE_BYTES } from '../types';

const logger = createLogger('SyncTransfer');

export interface TransferManifest {
	hashMatches(path: string, hash: string): boolean;
	setEntry(path: string, entry: FileEntry): void;
	removeEntry(path: string): void;
}

export interface TransferApi {
	uploadFile(
		path: string,
		content: ArrayBuffer,
		hash: string,
		size: number,
		contentType: string,
	): Promise<UploadResult>;
	downloadFile(path: string): Promise<{ content: ArrayBuffer; contentType: string; size: number }>;
	deleteFile(path: string): Promise<{ success: boolean; path: string }>;
	batchUpload(files: BatchUploadFile[]): Promise<BatchUploadResponse>;
	batchDownload(paths: string[]): Promise<BatchDownloadResponse>;
}

export interface TransferContext {
	vault: Vault;
	api: TransferApi;
	localManifest: TransferManifest;
	runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>;
	retryWithBackoff<T>(fn: () => Promise<T>): Promise<T>;
	getModifiedIso(path: string, fallbackMtime?: number): Promise<string>;
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
): Promise<PreparedUpload | null> {
	if (file.size > MAX_FILE_SIZE_BYTES) {
		logger.warn('Skipping large file:', file.path);
		return null;
	}

	const content = await context.vault.adapter.readBinary(file.path);
	const hash = await computeHash(content);

	if (context.localManifest.hashMatches(file.path, hash)) {
		logger.debug('Skipping unchanged file:', file.path);
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
): Promise<PreparedUpload | null> {
	const file = context.vault.getAbstractFileByPath(path);
	if (file && 'extension' in file) {
		return prepareUpload(context, file as TFile);
	}

	if (!isHiddenPath(path)) {
		return null;
	}

	const stat = await context.vault.adapter.stat(path);
	if (!stat || stat.type !== 'file') {
		return null;
	}

	return prepareUploadFromVaultFile(context, {
		path,
		size: stat.size,
		mtime: stat.mtime,
		extension: getExtensionFromPath(path),
	});
}

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
}

export async function saveDownloadedContent(
	context: TransferContext,
	path: string,
	content: ArrayBuffer,
): Promise<void> {
	if (content.byteLength > MAX_FILE_SIZE_BYTES) {
		throw new Error('Skipped remote file larger than 25MB');
	}

	const folderPath = path.substring(0, path.lastIndexOf('/'));
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
		if (existingFile) {
			await context.vault.modifyBinary(existingFile as TFile, content);
		} else {
			await context.vault.createBinary(path, content);
		}
	}

	const hash = await computeHash(content);
	context.localManifest.setEntry(path, {
		hash,
		size: content.byteLength,
		modified: await context.getModifiedIso(path),
	});
}

async function downloadFilesIndividually(
	context: TransferContext,
	paths: string[],
	result: SyncResult,
	concurrency: number,
): Promise<void> {
	const tasks = paths.map(path => async () => {
		try {
			await downloadAndSaveFile(context, path, result);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Download failed';
			result.errors.push(`${path}: ${errorMessage}`);
		}
	});
	await context.runConcurrent(tasks, concurrency);
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
		// We don't know remote sizes yet, so batch all and let the worker handle it.
		// Files that exceed limits will be caught on save.
		batchable.push(path);
	}

	if (batchable.length > 0) {
		const chunks: string[][] = [];
		for (let i = 0; i < batchable.length; i += BATCH_MAX_FILES) {
			chunks.push(batchable.slice(i, i + BATCH_MAX_FILES));
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
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : 'Download failed';
						result.errors.push(`${file.path}: ${errorMessage}`);
					}
				}
			} catch (error) {
				// Batch failed entirely, fall back to individual downloads for this chunk
				logger.warn('Batch download failed, falling back to individual downloads:', error instanceof Error ? error.message : 'Unknown error');
				individual.push(...chunk);
			}
		}
	}

	if (individual.length > 0) {
		await downloadFilesIndividually(context, individual, result, concurrency);
	}
}

export async function processDiff(
	context: TransferContext,
	diff: FileDiff,
	localFiles: Record<string, FileEntry>,
	result: SyncResult,
): Promise<void> {
	const hidden = isHiddenPath(diff.path);

	switch (diff.action) {
		case 'upload': {
			const uploadFile = await prepareUploadFromPath(context, diff.path);
			if (uploadFile) {
				const uploadResult = await context.api.uploadFile(
					uploadFile.path,
					uploadFile.content,
					uploadFile.hash,
					uploadFile.size,
					uploadFile.contentType || 'application/octet-stream',
				);
				if (!uploadResult.success) {
					throw new Error(uploadResult.error || 'Upload failed');
				}

				result.uploaded++;
				const modified = await context.getModifiedIso(uploadFile.path, uploadFile.mtime);
				const entry: FileEntry = {
					hash: uploadFile.hash,
					size: uploadFile.size,
					modified,
				};
				context.localManifest.setEntry(uploadFile.path, entry);
				localFiles[uploadFile.path] = entry;
			}
			break;
		}

		case 'download': {
			await downloadAndSaveFile(context, diff.path, result);
			const content = await context.vault.adapter.readBinary(diff.path);
			const hash = await computeHash(content);
			localFiles[diff.path] = {
				hash,
				size: content.byteLength,
				modified: await context.getModifiedIso(diff.path),
			};
			break;
		}

		case 'conflict': {
			const response = await context.api.downloadFile(diff.path);
			const remoteContent = response.content;
			if (remoteContent.byteLength > MAX_FILE_SIZE_BYTES) {
				throw new Error('Skipped remote file larger than 25MB');
			}

			const localFile = context.vault.getAbstractFileByPath(diff.path);
			const hasLocalFile = localFile && 'extension' in localFile;
			const hasHiddenFile = hidden && await context.vault.adapter.exists(diff.path);

			if (hasLocalFile || hasHiddenFile) {
				const localContent = await context.vault.adapter.readBinary(diff.path);
				const conflictPath = await createConflictCopy(context.vault, diff.path, localContent);

				if (hasLocalFile) {
					await context.vault.modifyBinary(localFile as TFile, remoteContent);
				} else {
					await context.vault.adapter.writeBinary(diff.path, remoteContent);
				}

				result.conflicts.push(conflictPath);

				const hash = await computeHash(remoteContent);
				const entry: FileEntry = {
					hash,
					size: remoteContent.byteLength,
					modified: await context.getModifiedIso(diff.path),
				};
				localFiles[diff.path] = entry;
				context.localManifest.setEntry(diff.path, entry);
			}
			break;
		}

		case 'delete': {
			await context.api.deleteFile(diff.path);
			delete localFiles[diff.path];
			context.localManifest.removeEntry(diff.path);
			result.deleted++;
			break;
		}
	}
}

export async function prepareUploadsFromVaultFiles(
	context: TransferContext,
	files: VaultFile[],
	concurrency: number,
	onPrepared?: (completed: number) => void,
): Promise<PreparedUpload[]> {
	let completed = 0;

	const tasks = files.map(file => async () => {
		const uploadFile = await prepareUploadFromVaultFile(context, file);
		completed++;
		onPrepared?.(completed);
		return uploadFile;
	});

	const prepared = await context.runConcurrent(tasks, concurrency);
	return prepared.filter((upload): upload is PreparedUpload => upload !== null);
}

export function createBatchUploadChunks(prepared: PreparedUpload[]): PreparedUpload[][] {
	const chunks: PreparedUpload[][] = [];
	let currentChunk: PreparedUpload[] = [];
	let currentBytes = 0;

	for (const upload of prepared) {
		if (currentChunk.length >= BATCH_MAX_FILES || (currentChunk.length > 0 && currentBytes + upload.size > BATCH_MAX_BYTES)) {
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

async function uploadPreparedFilesIndividually(
	context: TransferContext,
	prepared: PreparedUpload[],
	result: SyncResult,
	options: { concurrency: number; retry: boolean },
): Promise<void> {
	const tasks = prepared.map(upload => async () => {
		try {
			const doUpload = () => context.api.uploadFile(
				upload.path,
				upload.content,
				upload.hash,
				upload.size,
				upload.contentType || 'application/octet-stream',
			);
			const uploadResult = options.retry
				? await context.retryWithBackoff(doUpload)
				: await doUpload();

			if (uploadResult.success) {
				if (uploadResult.hash && uploadResult.hash !== upload.hash) {
					result.errors.push(`${upload.path}: Hash mismatch after upload (expected ${upload.hash}, got ${uploadResult.hash})`);
					return;
				}
				result.uploaded++;
				context.localManifest.setEntry(upload.path, {
					hash: upload.hash,
					size: upload.size,
					modified: await context.getModifiedIso(upload.path, upload.mtime),
				});
			} else {
				result.errors.push(`${upload.path}: ${uploadResult.error || 'Upload failed'}`);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Upload failed';
			result.errors.push(`${upload.path}: ${errorMessage}`);
		}
	});

	await context.runConcurrent(tasks, options.concurrency);
}

export async function uploadPreparedFiles(
	context: TransferContext,
	prepared: PreparedUpload[],
	result: SyncResult,
	options: { concurrency: number; retry: boolean },
): Promise<void> {
	if (prepared.length === 0) return;

	logger.info(`Uploading ${prepared.length} files`);

	const batchable = prepared.filter(f => f.size < BATCH_FILE_SIZE_LIMIT);
	const individual = prepared.filter(f => f.size >= BATCH_FILE_SIZE_LIMIT);

	if (batchable.length > 0) {
		const chunks = createBatchUploadChunks(batchable);
		for (const chunk of chunks) {
			try {
				const files: BatchUploadFile[] = chunk.map(upload => ({
					path: upload.path,
					content: arrayBufferToBase64(upload.content),
					hash: upload.hash,
					size: upload.size,
					contentType: upload.contentType || 'application/octet-stream',
				}));

				const doBatch = () => context.api.batchUpload(files);
				const response = options.retry
					? await context.retryWithBackoff(doBatch)
					: await doBatch();

				for (const fileResult of response.results) {
					const upload = chunk.find(u => u.path === fileResult.path);
					if (!upload) continue;

					if (fileResult.success) {
						if (fileResult.hash && fileResult.hash !== upload.hash) {
							result.errors.push(`${upload.path}: Hash mismatch after upload (expected ${upload.hash}, got ${fileResult.hash})`);
							continue;
						}
						result.uploaded++;
						context.localManifest.setEntry(upload.path, {
							hash: upload.hash,
							size: upload.size,
							modified: await context.getModifiedIso(upload.path, upload.mtime),
						});
					} else {
						result.errors.push(`${upload.path}: ${fileResult.error || 'Upload failed'}`);
					}
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Batch upload failed';
				for (const upload of chunk) {
					result.errors.push(`${upload.path}: ${errorMessage}`);
				}
			}
		}
	}

	if (individual.length > 0) {
		await uploadPreparedFilesIndividually(context, individual, result, options);
	}
}

export function createVaultFileChunks(files: VaultFile[], chunkSize: number): VaultFile[][] {
	if (files.length === 0) return [];
	const chunks: VaultFile[][] = [];
	for (let i = 0; i < files.length; i += chunkSize) {
		chunks.push(files.slice(i, i + chunkSize));
	}
	return chunks;
}

function getContentType(extension: string): string {
	const types: Record<string, string> = {
		md: 'text/markdown',
		txt: 'text/plain',
		json: 'application/json',
		css: 'text/css',
		js: 'application/javascript',
		ts: 'application/typescript',
		html: 'text/html',
		xml: 'application/xml',
		yaml: 'text/yaml',
		yml: 'text/yaml',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		svg: 'image/svg+xml',
		pdf: 'application/pdf',
	};
	return types[extension.toLowerCase()] || 'application/octet-stream';
}
