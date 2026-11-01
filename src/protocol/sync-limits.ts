/**
 * Sync transport limits shared by the Obsidian client and Cloudflare Worker.
 *
 * Mutation batches keep each request's measured worst case within D1's 50 queries
 * per invocation (D1_QUERIES_PER_INVOCATION in the Worker's platform limits) after
 * authentication. Staging an upload costs one query per file, and each file then
 * commits in its own invocation; a delete batch costs one query per file.
 */
export const BATCH_UPLOAD_MAX_FILES = 32;
export const BATCH_DELETE_MAX_FILES = 32;
export const BATCH_DOWNLOAD_MAX_FILES = 50;

export const BATCH_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const BATCH_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const BATCH_FILE_SIZE_LIMIT = 1 * 1024 * 1024;
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export const BULK_NEW_UPLOAD_CAPABILITY = 'bulk-new-file-uploads-v1';

/** Largest plaintext file, in bytes, that history, restore and pending-change previews show. */
export const MAX_PREVIEW_BYTES = 256_000;

/** Encrypted file descriptors returned by one `/encryption/metadata` request. */
export const ENCRYPTION_METADATA_BATCH = 1000;
