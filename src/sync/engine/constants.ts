export const AUTH_ERROR_MESSAGE = 'This device’s sync access is no longer valid. In Crate settings → Account and devices, select “Reconnect”.';
export const DOWNLOAD_CONCURRENCY = 2;
export const PREPARE_CONCURRENCY = 2;
export const MAX_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const MAX_CHECK_BACKOFF_MULTIPLIER = 32;
// Local-only content checks while automatic sync is off (the default interval).
export const LOCAL_CONTENT_CHECK_INTERVAL_MS = 300_000;
