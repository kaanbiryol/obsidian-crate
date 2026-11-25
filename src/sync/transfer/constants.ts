export const DOWNLOAD_CONCURRENCY = 2;
export const PREPARE_CONCURRENCY = 2;
export const UPLOAD_CONCURRENCY = 2;
export const BATCH_DELETE_CONCURRENCY = 2;
// Remote changes each read, hash or trash one local file; mostly small notes, whose cost is
// filesystem latency rather than memory.
export const REMOTE_RECONCILE_CONCURRENCY = 4;
