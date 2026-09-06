/** File metadata and projection intent share the same D1 transaction. */
export function enqueueFileProjection(db: D1Database, path: string, storageKey: string): D1PreparedStatement[] {
  if (!path.toLowerCase().endsWith('.md')) return [];
  return [db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
    SELECT ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)
    ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL, updated_at = datetime('now')`)
    .bind(path, storageKey, path, storageKey)];
}
