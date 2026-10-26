/**
 * Sync transport limits shared by the Obsidian client and Cloudflare Worker.
 *
 * Mutation batches stay deliberately small so a worst-case stale write remains
 * below D1's 50-query Workers Free limit after authentication and cleanup.
 */
import { isMarkdownPath } from './note-paths';

export const BATCH_UPLOAD_MAX_FILES = 3;
// Non-Markdown files do not incur reminder-index mutations.
export const BATCH_ASSET_UPLOAD_MAX_FILES = 4;
export const BATCH_DELETE_MAX_FILES = 4;
export const BATCH_DOWNLOAD_MAX_FILES = 50;

export const BATCH_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const BATCH_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const BATCH_FILE_SIZE_LIMIT = 1 * 1024 * 1024;
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export const BULK_NEW_UPLOAD_MAX_FILES = 8;
export const BULK_NEW_UPLOAD_CAPABILITY = 'bulk-new-file-uploads-v1';

/** Most files one batch upload request may carry. Only files with an absent
 * precondition qualify for a new-file import, and only when `bulkNewEligible`:
 * the vault is unencrypted and the server has `BULK_NEW_UPLOAD_CAPABILITY`. */
export function maxUploadBatchFiles(
	files: ReadonlyArray<{ path: string; expectedHash?: string | null }>,
	bulkNewEligible: boolean,
): number {
	if (bulkNewEligible && files.every(file => file.expectedHash === null)) return BULK_NEW_UPLOAD_MAX_FILES;
	return files.some(file => isMarkdownPath(file.path)) ? BATCH_UPLOAD_MAX_FILES : BATCH_ASSET_UPLOAD_MAX_FILES;
}

/** Largest plaintext file, in bytes, that history, restore and pending-change previews show. */
export const MAX_PREVIEW_BYTES = 256_000;

/** Encrypted file descriptors returned by one `/encryption/metadata` request. */
export const ENCRYPTION_METADATA_BATCH = 1000;
