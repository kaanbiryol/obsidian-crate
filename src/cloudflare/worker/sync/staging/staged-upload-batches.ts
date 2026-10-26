import { portablePathKey } from '../../../../protocol/portable-path';
import type { ObjectReference } from '../../storage-references';
import { STAGED_UPLOAD_TTL_MS } from './staged-uploads';
import { EncryptionStateError, encryptionWriteGuard } from '../../encryption/state';
import { changedRows, type SqlGuard } from '../../db';
import { syncResetGenerationGuard } from '../reset-generation';

/** Each request attempt owns distinct immutable keys, including failed R2 puts. */
export async function trackStagedBatch(db: D1Database, storageKeys: ObjectReference[], resetGeneration?: string | null): Promise<string | undefined> {
  if (!storageKeys.length) return undefined;
  const id = crypto.randomUUID();
  const plaintext = encryptionWriteGuard(null);
  const resetGuard = syncResetGenerationGuard(resetGeneration);
  const result = await db.prepare(`INSERT INTO staged_upload_batches(id, storage_keys, expires_at)
    SELECT ?, ?, unixepoch('now') * 1000 + ? WHERE ${plaintext.sql} AND ${resetGuard.sql}`)
    .bind(id, JSON.stringify(storageKeys), STAGED_UPLOAD_TTL_MS, ...plaintext.args, ...resetGuard.args).run();
  if (changedRows(result) !== 1) throw new EncryptionStateError('Encryption changed before this upload. Reconnect before syncing.', 428);
  return id;
}

export function stagedBatchGuard(id: string, storageKey: string): SqlGuard {
  return { sql: `EXISTS (SELECT 1 FROM staged_upload_batches b WHERE b.id = ?
    AND b.state = 'pending' AND b.expires_at > unixepoch('now') * 1000
    AND EXISTS (SELECT 1 FROM json_each(b.storage_keys) WHERE json_extract(value, '$.storageKey') = ?))`, args: [id, storageKey] };
}

/** Publication, durable cleanup of rejected keys, and lease completion are atomic.
 * Keys whose R2 puts failed remain leased: a lost response may hide a late put. */
export function finishStagedBatches(db: D1Database, files: Array<{ path: string; objectKey: string; stagingBatchId?: string }>): D1PreparedStatement[] {
  const entries = files.filter(file => file.stagingBatchId).map(file => ({ id: file.stagingBatchId, key: file.objectKey, path: file.path, portable: portablePathKey(file.path) }));
  if (!entries.length) return [];
  const json = JSON.stringify(entries);
  const input = `WITH input AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.key') AS key, json_extract(value, '$.path') AS path, json_extract(value, '$.portable') AS portable FROM json_each(?)) `;
  const remaining = `SELECT value FROM json_each(staged_upload_batches.storage_keys) k
    WHERE NOT EXISTS (SELECT 1 FROM input i WHERE i.id = staged_upload_batches.id AND i.key = json_extract(k.value, '$.storageKey'))`;
  return [
    db.prepare(input + `INSERT OR IGNORE INTO object_cleanup_queue(storage_key, file_path)
      SELECT key, path FROM input WHERE NOT EXISTS (SELECT 1 FROM files WHERE portable_path = input.portable AND storage_key = input.key)`).bind(json),
    db.prepare(input + `DELETE FROM staged_upload_batches WHERE id IN (SELECT id FROM input)
      AND NOT EXISTS (${remaining})`).bind(json),
    db.prepare(input + `UPDATE staged_upload_batches SET storage_keys = (SELECT json_group_array(json(value)) FROM (${remaining}))
      WHERE id IN (SELECT id FROM input)`).bind(json),
  ];
}
