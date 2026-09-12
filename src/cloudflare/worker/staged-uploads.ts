/** A publication lease. Cleanup may claim it after 24 hours, never before. */
export const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export async function trackStagedUpload(db: D1Database, storageKey: string): Promise<void> {
  await db.prepare("INSERT INTO staged_uploads(storage_key, expires_at) VALUES (?, unixepoch('now') * 1000 + ?)")
    .bind(storageKey, STAGED_UPLOAD_TTL_MS).run();
}

export function stagedUploadGuard(storageKey: string): { sql: string; args: string[] } {
  return { sql: `EXISTS (SELECT 1 FROM staged_uploads WHERE storage_key = ?
    AND state = 'pending' AND expires_at > unixepoch('now') * 1000)`, args: [storageKey] };
}

/** Remove the intent only in the transaction that makes its object live. */
export function finishStagedUpload(db: D1Database, storageKey: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM staged_uploads WHERE storage_key = ?
    AND EXISTS (SELECT 1 FROM files WHERE storage_key = ?)`).bind(storageKey, storageKey);
}
