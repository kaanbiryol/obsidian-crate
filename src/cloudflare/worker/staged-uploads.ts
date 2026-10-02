import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { objectReference, type ObjectReference } from './storage-references';
import { EncryptionStateError, encryptionWriteGuard } from './encryption-state';
import { changedRows } from './db';
import { validateEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { syncResetGenerationGuard } from './sync-reset-generation';
/** A publication lease. Cleanup may claim it after 24 hours, never before. */
export const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const stagingEncryptionGuard = `NOT EXISTS (SELECT 1 FROM maintenance_state WHERE key = 'e2ee:state')
  OR (? = 1 AND EXISTS (SELECT 1 FROM maintenance_state WHERE key = 'e2ee:state' AND json_extract(value, '$.mode') = 'active'))`;

export async function trackStagedUpload(db: D1Database, storageKey: string, path?: string, encrypted = false): Promise<void> {
  const result = await db.prepare(`INSERT INTO staged_uploads(storage_key, file_path, expires_at)
    SELECT ?, ?, unixepoch('now') * 1000 + ? WHERE ${stagingEncryptionGuard}`)
    .bind(storageKey, path ?? null, STAGED_UPLOAD_TTL_MS, encrypted ? 1 : 0).run();
  if (changedRows(result) !== 1) throw new EncryptionStateError('Encryption changed before this upload. Reconnect before syncing.', 428);
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
export async function trackStagedUploads(db: D1Database, storageKeys: Array<string | ObjectReference>, encrypted = false, expectedEncryption?: EncryptionServerState | null, resetGeneration?: string | null): Promise<EncryptionServerState | null> {
  if (!storageKeys.length) return null;
  const authority = expectedEncryption === undefined ? { sql: '1', args: [] } : encryptionWriteGuard(expectedEncryption);
  const resetGuard = syncResetGenerationGuard(resetGeneration);
  const result = await db.prepare(`INSERT INTO staged_uploads(storage_key, file_path, expires_at)
    SELECT json_extract(value, '$.storageKey'), json_extract(value, '$.path'), unixepoch('now') * 1000 + ? FROM json_each(?)
    WHERE (${stagingEncryptionGuard}) AND (${authority.sql}) AND ${resetGuard.sql} RETURNING (SELECT value FROM maintenance_state WHERE key = 'e2ee:state') AS encryption_state`)
    .bind(STAGED_UPLOAD_TTL_MS, JSON.stringify(storageKeys.map(objectReference)), encrypted ? 1 : 0, ...authority.args, ...resetGuard.args).all<{ encryption_state: string | null }>();
  if (result.results.length !== storageKeys.length) throw new EncryptionStateError('Encryption changed before this upload. Reconnect before syncing.', 428);
  const raw = result.results[0]?.encryption_state;
  if (!raw) return null;
  const state: unknown = JSON.parse(raw); validateEncryptionState(state); return state;
}
