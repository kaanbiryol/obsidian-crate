import { Platform } from 'obsidian';

export const DOWNLOAD_CONCURRENCY = 2;
export const PREPARE_CONCURRENCY = 2;
export const UPLOAD_CONCURRENCY = 2;
// Overlap small requests on desktop without increasing per-request server work.
export const BATCH_UPLOAD_CONCURRENCY = Platform.isMobile ? 2 : 4;
export const BATCH_DELETE_CONCURRENCY = 2;
