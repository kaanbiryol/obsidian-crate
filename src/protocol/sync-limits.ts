/**
 * Sync transport limits shared by the Obsidian client and Cloudflare Worker.
 *
 * Mutation batches stay deliberately small so a worst-case stale write remains
 * below D1's 50-query Workers Free limit after authentication and cleanup.
 */
export const BATCH_UPLOAD_MAX_FILES = 5;
export const BATCH_DELETE_MAX_FILES = 6;
export const BATCH_DOWNLOAD_MAX_FILES = 50;

export const BATCH_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const BATCH_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const BATCH_FILE_SIZE_LIMIT = 1 * 1024 * 1024;
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
