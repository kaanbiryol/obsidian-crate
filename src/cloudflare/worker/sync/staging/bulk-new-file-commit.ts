import { portablePathKey } from '../../../../protocol/portable-path';
import { uploadMutation } from '../mutations';
import { bulkFileProjection } from './bulk-file-projection';
import { readingIndexStatements, type ReadingIndexPolicy } from '../../reading/library-index';
import { decodeReceipt, recordUploadReceipt, type UploadOperation } from '../upload-operations';
import { deleteBucketObjectsOrQueue } from '../../maintenance/object-cleanup';
import type { UploadResult } from '@/protocol/sync-types';
import { finishStagedBatches } from './staged-upload-batches';

export interface NewFileUpload {
	reminderPolicyRevision?: string | null;
	path: string; hash: string; size: number; objectKey: string; content: ArrayBuffer; operation: UploadOperation;
	stagingBatchId?: string;
	resetGeneration?: string | null;
}

/** Inserts remain sequential inside one transaction: namespace guards see earlier inserts.
 * Everything derived from a file is conditional on this request's immutable revision. */
export async function commitNewFiles(bucket: R2Bucket, db: D1Database, files: NewFileUpload[], reminderFolder?: string | null, readingPolicy?: ReadingIndexPolicy): Promise<UploadResult[]> {
	if (!files.length) return [];
	const json = JSON.stringify(files.map(file => ({ path: file.path, portable: portablePathKey(file.path), hash: file.hash, size: file.size, key: file.objectKey })));
	const published = [
		...files.map(file => uploadMutation(db, {
			path: file.path, hash: file.hash, size: file.size, objectKey: file.objectKey,
			expectedHash: null, operation: file.operation, stagingBatchId: file.stagingBatchId,
			encryptionState: null, resetGeneration: file.resetGeneration,
		})),
		db.prepare(`INSERT INTO changelog(path, action, hash, size, revision)
      SELECT f.path, 'put', f.hash, f.size, f.storage_key FROM json_each(?) i JOIN files f
      ON f.portable_path = json_extract(i.value, '$.portable') AND f.path = json_extract(i.value, '$.path') AND f.storage_key = json_extract(i.value, '$.key')`).bind(json),
		...await bulkFileProjection(db, files, reminderFolder),
		...await readingIndexStatements(db, files.map(file => ({ path: file.path, storageKey: file.objectKey, hash: file.hash, size: file.size, content: file.content })), { policy: readingPolicy }),
	];
	const batch: unknown[] = await db.batch([
		...published,
		...files.map(file => recordUploadReceipt(db, file.operation, file)),
		...finishStagedBatches(db, files),
	]);
	// Each receipt this commit wrote comes back with it. A concurrent replay wrote its
	// receipt first, so only those operations need a read.
	const written = files.map((_, index) => (batch[published.length + index] as { results?: Array<{ response_json: string }> } | undefined)?.results?.[0]?.response_json);
	const replayed = files.filter((_, index) => written[index] === undefined);
	const rows = replayed.length ? (await db.prepare(`SELECT operation_id, request_hash, response_json FROM upload_operations
    WHERE operation_id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(replayed.map(file => file.operation.id)))
		.all<{ operation_id: string; request_hash: string; response_json: string }>()).results : [];
	const receipts = new Map(rows.map(row => [row.operation_id, row]));
	const unused: string[] = [];
	const results = files.map((file, index) => {
		const row = written[index] !== undefined ? { request_hash: file.operation.requestHash, response_json: written[index] } : receipts.get(file.operation.id);
		if (!row) throw new Error('Upload receipt is unavailable; retry the same operation');
		const result: UploadResult = row.request_hash === file.operation.requestHash ? decodeReceipt(row.response_json)
			: { success: false, path: file.path, status: 409, code: 'operation_mismatch', error: 'Upload operation identity was reused' };
		if (result.revision !== file.objectKey) unused.push(file.objectKey);
		return result;
	});
	await deleteBucketObjectsOrQueue(bucket, db, files.filter(file => unused.includes(file.objectKey)).map(file => ({ storageKey: file.objectKey, path: file.path })));
	return results;
}
