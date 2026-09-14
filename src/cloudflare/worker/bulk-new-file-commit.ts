import { portablePathKey } from '../../protocol/portable-path';
import { uploadMutation } from './sync-mutations';
import { bulkFileProjection } from './bulk-file-projection';
import { decodeReceipt, recordUploadReceipt, type UploadOperation } from './upload-operations';
import { deleteBucketObjectsOrQueue } from './sync-storage';
import type { UploadResult } from '@/protocol/sync-types';
import { finishStagedBatches } from './staged-upload-batches';

export interface NewFileUpload {
  reminderPolicyRevision?: string | null;
  path: string; hash: string; size: number; objectKey: string; content: ArrayBuffer; operation: UploadOperation;
  stagingBatchId?: string;
}

/** Inserts remain sequential inside one transaction: namespace guards see earlier inserts.
 * Everything derived from a file is conditional on this request's immutable revision. */
export async function commitNewFiles(bucket: R2Bucket, db: D1Database, files: NewFileUpload[]): Promise<UploadResult[]> {
  if (!files.length) return [];
  const json = JSON.stringify(files.map(file => ({ path: file.path, portable: portablePathKey(file.path), hash: file.hash, size: file.size, key: file.objectKey })));
  await db.batch([
    ...files.map(file => uploadMutation(db, file.path, file.hash, file.size, file.objectKey, null, file.operation, undefined, file.stagingBatchId)),
    db.prepare(`INSERT INTO changelog(path, action, hash, size, revision)
      SELECT f.path, 'put', f.hash, f.size, f.storage_key FROM json_each(?) i JOIN files f
      ON f.portable_path = json_extract(i.value, '$.portable') AND f.path = json_extract(i.value, '$.path') AND f.storage_key = json_extract(i.value, '$.key')`).bind(json),
    ...await bulkFileProjection(db, files),
    db.prepare(`DELETE FROM staged_uploads WHERE storage_key IN (
      SELECT f.storage_key FROM json_each(?) i JOIN files f
      ON f.portable_path = json_extract(i.value, '$.portable') AND f.path = json_extract(i.value, '$.path') AND f.storage_key = json_extract(i.value, '$.key'))`).bind(json),
    ...files.map(file => recordUploadReceipt(db, file.operation, file)),
    ...finishStagedBatches(db, files),
  ]);
  // Read all durable receipts together, including a concurrent replay's original receipt.
  const rows = await db.prepare(`SELECT operation_id, request_hash, response_json FROM upload_operations
    WHERE operation_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(files.map(file => file.operation.id)))
    .all<{ operation_id: string; request_hash: string; response_json: string }>();
  const receipts = new Map(rows.results.map(row => [row.operation_id, row]));
  const unused: string[] = [];
  const results = files.map(file => {
    const row = receipts.get(file.operation.id);
    if (!row) throw new Error('Upload receipt is unavailable; retry the same operation');
    const result: UploadResult = row.request_hash === file.operation.requestHash ? decodeReceipt(row.response_json)
      : { success: false, path: file.path, status: 409, code: 'operation_mismatch', error: 'Upload operation identity was reused' };
    if (result.revision !== file.objectKey) unused.push(file.objectKey);
    return result;
  });
  await deleteBucketObjectsOrQueue(bucket, db, files.filter(file => unused.includes(file.objectKey)).map(file => ({ storageKey: file.objectKey, path: file.path })));
  return results;
}
