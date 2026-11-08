/** Ready files and retry deadlines each have their own bounded index range. Paths this
 * pass just verified (a JSON array, the first parameter) come first: verification
 * re-enqueues them at the current time, which would put older jobs ahead of them. */
export const READY_PROJECTION_JOBS_SQL = `SELECT path, job_token FROM (
  SELECT j.path, j.job_token, j.updated_at, 0 AS later FROM json_each(?) v
    JOIN notification_projection_jobs j ON j.path = v.value WHERE j.last_error IS NULL
  UNION ALL SELECT * FROM (
    SELECT path, job_token, updated_at, 1 FROM notification_projection_jobs
    WHERE last_error IS NULL ORDER BY updated_at, path LIMIT ?
  ) UNION ALL SELECT * FROM (
    SELECT j.path, j.job_token, j.updated_at, 1 FROM notification_file_retries r
    JOIN notification_projection_jobs j ON j.path = r.path
    WHERE r.available_at >= 0 AND r.available_at <= unixepoch('now') * 1000
      AND j.last_error IS NOT NULL
    ORDER BY r.available_at, r.path LIMIT ?
  )
) GROUP BY path ORDER BY MIN(later), updated_at, path LIMIT ?`;

export const NEXT_NOTIFICATION_WORK_SQL = `SELECT
  EXISTS(SELECT 1 FROM notification_projection_jobs WHERE last_error IS NULL LIMIT 1) AS ready,
  (SELECT available_at FROM notification_file_retries WHERE available_at >= 0
    ORDER BY available_at, path LIMIT 1) AS projectionRetry,
  (SELECT available_at FROM notification_jobs WHERE available_at >= 0 ORDER BY available_at LIMIT 1) AS dispatchAt`;

export const NEXT_SOURCE_RETRY_SQL = `SELECT available_at AS retryAt FROM notification_file_retries
  WHERE available_at >= 0 ORDER BY available_at, path LIMIT 1`;

const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

/** Backoff before retry `attempt` of a schedule job or a reminder delivery. */
export function notificationRetryDelayMs(attempt: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.min(attempt, 8)), RETRY_MAX_DELAY_MS);
}
