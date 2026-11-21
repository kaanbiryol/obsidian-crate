/**
 * Sync transport limits shared by the Obsidian client and Cloudflare Worker.
 *
 * Mutation batches keep each request's measured worst case within D1's 50 queries
 * per invocation (D1_QUERIES_PER_INVOCATION in the Worker's platform limits) after
 * authentication. Staging an upload batch costs two queries, and each file then
 * commits in its own invocation; a delete batch costs one query per file.
 */
export const BATCH_UPLOAD_MAX_FILES = 32;
export const BATCH_DELETE_MAX_FILES = 32;
export const BATCH_DOWNLOAD_MAX_FILES = 50;

export const BATCH_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const BATCH_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const BATCH_FILE_SIZE_LIMIT = 1 * 1024 * 1024;
/** The default largest synced file, and the only limit on Cloudflare and on mobile devices. */
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
/** The largest file a self-hosted server may allow. Transfers are buffered whole on both sides,
 * and an encrypted upload's journal record holds about 3.1 times the file as one string,
 * which must stay below JavaScript's 2^29-character string limit (about 164 MiB of file). */
export const MAX_CONFIGURABLE_FILE_BYTES = 128 * 1024 * 1024;

/** A server's configured file limit, or the default when it is missing or out of range. */
export function parseMaxFileBytes(value: unknown): number {
	const bytes = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
	return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= MAX_FILE_SIZE_BYTES && bytes <= MAX_CONFIGURABLE_FILE_BYTES
		? bytes : MAX_FILE_SIZE_BYTES;
}

/** The largest file this device transfers: mobile keeps the default for its memory budget. */
export function deviceFileLimit(serverMaxFileBytes: number, isMobile: boolean): number {
	return isMobile ? Math.min(serverMaxFileBytes, MAX_FILE_SIZE_BYTES) : serverMaxFileBytes;
}

/** Whole megabytes for messages, such as "25MB". */
export function formatFileLimit(bytes: number): string {
	return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

/** The server commits a batch of new files with one lease and one changelog insert, with or without encryption. */
export const BULK_NEW_UPLOAD_CAPABILITY = 'bulk-new-file-uploads-v1';

/** Largest plaintext file, in bytes, that history, restore and pending-change previews show. */
export const MAX_PREVIEW_BYTES = 256_000;

/** Encrypted file descriptors returned by one `/encryption/metadata` request. */
export const ENCRYPTION_METADATA_BATCH = 1000;
