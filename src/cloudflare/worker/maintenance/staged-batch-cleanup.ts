import { findReferencedStorageKeys, objectReference, type ObjectReference } from '../storage-references';
import { STAGED_UPLOAD_TTL_MS } from '../staged-uploads';

/** Two batches bound both D1 work and R2 requests during a maintenance pass. */
export async function cleanStagedBatches(bucket: R2Bucket, db: D1Database, now = Date.now()): Promise<number> {
  const rows = await db.prepare(`UPDATE staged_upload_batches SET state = 'deleting'
    WHERE id IN (SELECT id FROM staged_upload_batches WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 2)
    RETURNING id, storage_keys`).bind(now).all<{ id: string; storage_keys: string }>();
  let finished = 0;
  for (const row of rows.results) {
    const objects = (JSON.parse(row.storage_keys) as Array<string | ObjectReference>).map(objectReference);
    const keys = objects.map(object => object.storageKey);
    const referenced = await findReferencedStorageKeys(db, objects);
    const visible: string[] = [];
    const waiting: string[] = [];
    await Promise.all(keys.filter(key => !referenced.has(key)).map(async key => {
      try { (await bucket.head(key) ? visible : waiting).push(key); }
      catch { waiting.push(key); }
    }));
    try {
      if (visible.length) await bucket.delete(visible);
    } catch { waiting.push(...visible); }
    finished += keys.length - waiting.length;
    if (!waiting.length) {
      await db.prepare('DELETE FROM staged_upload_batches WHERE id = ? AND storage_keys = ?')
        .bind(row.id, row.storage_keys).run();
    } else {
      // An absent key can still arrive after a lost R2 response. Keep its lease
      // fenced against publication, and eventually surface it for inspection.
      await db.prepare(`UPDATE staged_upload_batches SET storage_keys = ?, attempts = attempts + 1,
        expires_at = CASE WHEN attempts + 1 >= 8 THEN NULL ELSE ? END,
        last_error = 'Object cleanup could not be confirmed; the upload record is retained'
        WHERE id = ? AND storage_keys = ?`)
        .bind(JSON.stringify(objects.filter(object => waiting.includes(object.storageKey))), now + STAGED_UPLOAD_TTL_MS, row.id, row.storage_keys).run();
    }
  }
  return finished;
}
