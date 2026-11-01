import { Platform } from 'obsidian';

export const DOWNLOAD_CONCURRENCY = 2;
export const PREPARE_CONCURRENCY = 2;
export const UPLOAD_CONCURRENCY = 2;
// Overlap small requests on desktop without increasing per-request server work.
export const BATCH_UPLOAD_CONCURRENCY = Platform.isMobile ? 2 : 4;
// Each batch runs in one of the Worker's eight transfer Durable Objects.
export const BATCH_DOWNLOAD_CONCURRENCY = Platform.isMobile ? 2 : 4;
// Files of one downloaded batch written to the vault at once.
export const DOWNLOAD_APPLY_CONCURRENCY = Platform.isMobile ? 2 : 4;
export const BATCH_DELETE_CONCURRENCY = 2;
