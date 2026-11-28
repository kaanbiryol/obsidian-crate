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
/** Renames one move batch carries. Its snapshot binds both paths of each, within 100 values. */
export const BATCH_MOVE_MAX_FILES = 32;

export const BATCH_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const BATCH_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const BATCH_FILE_SIZE_LIMIT = 1 * 1024 * 1024;

/** How many files, and bytes, one batch request carries. */
export interface BatchLimits {
	readonly uploadFiles: number;
	readonly uploadBytes: number;
	readonly downloadFiles: number;
	readonly downloadBytes: number;
	readonly deleteFiles: number;
}
/** Every server accepts these; Cloudflare's D1 query and Worker memory limits set them. */
export const DEFAULT_BATCH_LIMITS: BatchLimits = Object.freeze({ uploadFiles: BATCH_UPLOAD_MAX_FILES, uploadBytes: BATCH_UPLOAD_MAX_BYTES,
	downloadFiles: BATCH_DOWNLOAD_MAX_FILES, downloadBytes: BATCH_DOWNLOAD_MAX_BYTES, deleteFiles: BATCH_DELETE_MAX_FILES });
/** A self-hosted server has neither limit, so it advertises larger batches in `limits.batch`.
 * One statement still binds at most 100 values (`D1_MAX_BOUND_PARAMETERS`), which caps the files. */
export const SELF_HOSTED_BATCH_LIMITS: BatchLimits = Object.freeze({ uploadFiles: 100, uploadBytes: 32 * 1024 * 1024,
	downloadFiles: 100, downloadBytes: 32 * 1024 * 1024, deleteFiles: 100 });

/** A server's advertised batch limits, each between the default and the self-hosted size. */
export function parseBatchLimits(value: unknown): BatchLimits {
	if (!value || typeof value !== 'object') return DEFAULT_BATCH_LIMITS;
	const advertised = value as Record<string, unknown>;
	const pick = (name: keyof BatchLimits) => {
		const size = advertised[name];
		return typeof size === 'number' && Number.isSafeInteger(size) && size >= DEFAULT_BATCH_LIMITS[name] && size <= SELF_HOSTED_BATCH_LIMITS[name] ? size : DEFAULT_BATCH_LIMITS[name];
	};
	return { uploadFiles: pick('uploadFiles'), uploadBytes: pick('uploadBytes'), downloadFiles: pick('downloadFiles'),
		downloadBytes: pick('downloadBytes'), deleteFiles: pick('deleteFiles') };
}

/** Mobile keeps the default batches, which its memory budget is sized for. */
export function deviceBatchLimits(server: BatchLimits, isMobile: boolean): BatchLimits {
	return isMobile ? DEFAULT_BATCH_LIMITS : server;
}
/** The default largest synced file, and the only limit on Cloudflare and on mobile devices. */
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
/** The largest file a self-hosted server may allow. Files above the default travel in
 * `UPLOAD_PART_BYTES` parts, so only one in-memory copy of a file is needed. */
export const MAX_CONFIGURABLE_FILE_BYTES = 1024 * 1024 * 1024;
/** The largest file sent in one request: encrypted files, Markdown notes, and every file on a
 * server without chunked uploads. An encrypted upload's journal record holds about 3.1 times
 * the file as one string, which must stay below JavaScript's 2^29-character limit. */
export const MAX_BUFFERED_FILE_BYTES = 128 * 1024 * 1024;
/** One part of a chunked upload or ranged download: at least R2's 5 MiB part minimum and
 * below Cloudflare Tunnel's 100 MB request limit. */
export const UPLOAD_PART_BYTES = 32 * 1024 * 1024;
/** Servers with this capability accept chunked uploads and ranged downloads. */
export const CHUNKED_UPLOAD_CAPABILITY = 'chunked-uploads-v1';

/** A server's configured file limit, or the default when it is missing or out of range. */
export function parseMaxFileBytes(value: unknown): number {
	const bytes = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
	return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= MAX_FILE_SIZE_BYTES && bytes <= MAX_CONFIGURABLE_FILE_BYTES
		? bytes : MAX_FILE_SIZE_BYTES;
}

/** The largest file this device transfers: mobile keeps the default for its memory budget,
 * and an encrypted vault the buffered limit, since its files travel in one request. */
export function deviceFileLimit(serverMaxFileBytes: number, isMobile: boolean, encrypted: boolean): number {
	if (isMobile) return Math.min(serverMaxFileBytes, MAX_FILE_SIZE_BYTES);
	return encrypted ? Math.min(serverMaxFileBytes, MAX_BUFFERED_FILE_BYTES) : serverMaxFileBytes;
}

/** Whether a file travels in parts: plaintext attachments above the default limit, on a server
 * that accepts chunked uploads. Markdown stays in one request so the server can read it. */
export function usesChunkedTransfer(path: string, size: number, encrypted: boolean, chunkedServer: boolean): boolean {
	return chunkedServer && !encrypted && size > MAX_FILE_SIZE_BYTES && !path.toLowerCase().endsWith('.md');
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
