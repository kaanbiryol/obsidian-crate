import { HttpError } from './api';

export const AUTH_ERROR_MESSAGE = 'Authentication expired - please sign in again in plugin settings';
export const UPLOAD_CONCURRENCY = 2;
export const DOWNLOAD_CONCURRENCY = 2;
export const FORCE_SYNC_CONCURRENCY = 2;
export const PREPARE_CONCURRENCY = 2;
export const BATCH_UPLOAD_CONCURRENCY = 1;
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const MAX_CHECK_BACKOFF_MULTIPLIER = 32;

export function isAuthError(error: unknown): boolean {
	return error instanceof HttpError && error.status === 401;
}
