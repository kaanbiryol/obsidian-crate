import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { objectReference, type ObjectReference } from './storage-references';
/** A publication lease. Cleanup may claim it after 24 hours, never before. */
export const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export async function trackStagedUpload(db: D1Database, storageKey: string, path?: string): Promise<void> {
  await db.prepare("INSERT INTO staged_uploads(storage_key, file_path, expires_at) VALUES (?, ?, unixepoch('now') * 1000 + ?)")
    .bind(storageKey, path ?? null, STAGED_UPLOAD_TTL_MS).run();
}

export function stagedUploadGuard(storageKey: string): { sql: string; args: string[] } {
  return { sql: `EXISTS (SELECT 1 FROM staged_uploads WHERE storage_key = ?
    AND state = 'pending' AND expires_at > unixepoch('now') * 1000)`, args: [storageKey] };
}

/** Remove the intent only in the transaction that makes its object live. */
export function finishStagedUpload(db: D1Database, storageKey: string, path: string): D1PreparedStatement {
  return db.prepare(`DELETE FROM staged_uploads WHERE storage_key = ?
    AND EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?)`).bind(storageKey, ...filePathArgs(path), storageKey);
}

/** One durable lease registration for the whole request, before any R2 puts. */
export async function trackStagedUploads(db: D1Database, storageKeys: Array<string | ObjectReference>): Promise<void> {
  if (!storageKeys.length) return;
  await db.prepare("INSERT INTO staged_uploads(storage_key, file_path, expires_at) SELECT json_extract(value, '$.storageKey'), json_extract(value, '$.path'), unixepoch('now') * 1000 + ? FROM json_each(?)")
    .bind(STAGED_UPLOAD_TTL_MS, JSON.stringify(storageKeys.map(objectReference))).run();
}
