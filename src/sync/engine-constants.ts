import { Platform } from 'obsidian';
import { HttpError } from './api';

export const AUTH_ERROR_MESSAGE = 'This device’s sync access is no longer valid. In Crate settings → Account and devices, select “Reconnect”.';
export const UPLOAD_CONCURRENCY = 2;
export const DOWNLOAD_CONCURRENCY = 2;
export const FORCE_SYNC_CONCURRENCY = 2;
export const PREPARE_CONCURRENCY = 2;
// Overlap small requests on desktop without increasing per-request server work.
export const BATCH_UPLOAD_CONCURRENCY = Platform.isMobile ? 2 : 4;
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const MAX_CHECK_BACKOFF_MULTIPLIER = 32;

export function isAuthError(error: unknown): boolean {
	return error instanceof HttpError && error.status === 401;
}
