export const MAX_FILE_ATTEMPTS = 8;

/** Shared by source verification and projection so they cannot reset each other's budget. */
export function recordFileFailure(db: D1Database, path: string, error: string, guard = '1', args: unknown[] = [], permanent = false): D1PreparedStatement {
  return db.prepare(`INSERT INTO notification_file_retries(path, attempts, available_at, error)
    SELECT ?, 1, ?, ? WHERE ${guard}
    ON CONFLICT(path) DO UPDATE SET attempts = attempts + 1,
      available_at = CASE WHEN excluded.available_at < 0 THEN -1 WHEN attempts + 1 >= ${MAX_FILE_ATTEMPTS} THEN NULL ELSE excluded.available_at END,
      error = excluded.error`).bind(path, permanent ? -1 : Date.now() + 3600_000, error.slice(0, 512), ...args);
}
