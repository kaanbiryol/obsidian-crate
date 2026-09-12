import { queryRows } from '../db';
import { findReferencedStorageKeys } from '../storage-references';
import { STAGED_UPLOAD_TTL_MS } from '../staged-uploads';

/** Claim before checking R2: expired leases cannot publish after this point. */
export async function cleanStagedUploads(bucket: R2Bucket, db: D1Database, now = Date.now()): Promise<number> {
  const rows = await queryRows<{ storage_key: string }>(db.prepare(`UPDATE staged_uploads SET state = 'deleting'
    WHERE storage_key IN (SELECT storage_key FROM staged_uploads WHERE expires_at <= ?
      ORDER BY expires_at, storage_key LIMIT 10) RETURNING storage_key`).bind(now));
  const keys = rows.map(row => row.storage_key);
  if (!keys.length) return 0;
  const referenced = await findReferencedStorageKeys(db, keys);
  const visible: string[] = [];
  const waiting: string[] = [];
  await Promise.all(keys.filter(key => !referenced.has(key)).map(async key => {
    try { (await bucket.head(key) ? visible : waiting).push(key); }
    catch { waiting.push(key); }
  }));
  const finished = [...referenced];
  try {
    if (visible.length) await bucket.delete(visible.length === 1 ? visible[0]! : visible);
    finished.push(...visible);
  } catch { waiting.push(...visible); }
  await db.batch([
    db.prepare('DELETE FROM staged_uploads WHERE storage_key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(finished)),
    // An absent object may still be uploading. Keep its record instead of losing a late write.
    db.prepare(`UPDATE staged_uploads SET attempts = attempts + 1,
      expires_at = CASE WHEN attempts + 1 >= 8 THEN NULL ELSE ? END,
      last_error = 'Object cleanup could not be confirmed; the upload record is retained'
      WHERE storage_key IN (SELECT value FROM json_each(?))`)
      .bind(now + STAGED_UPLOAD_TTL_MS, JSON.stringify(waiting)),
  ]);
  return finished.length;
}
