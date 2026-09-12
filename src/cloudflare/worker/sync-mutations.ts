import { stagedUploadGuard, finishStagedUpload } from './staged-uploads';
import { readUploadReceipt, recordUploadReceipt, type UploadOperation } from './upload-operations';
import type { UploadResult } from '@/protocol/sync-types';
import { enqueueFileProjection } from './notification-projection-queue';
import type { CommitEffects } from './commit-effects';
import { changedRows } from './db';
import { sha256HexBytes } from './auth';
import { portablePathKey } from '../../protocol/portable-path';
import { assertFileNamespaceAvailable, FileNamespaceConflictError, fileNamespaceGuard } from './file-namespace';
import { findFileDeletionReceipt, recordFileDeletion, type FileDeletionReceipt } from './file-delete-audit';
import type { MutationAuditContext } from './request-diagnostics';
import {
	collectCleanupKeys,
	deleteBucketObjectsOrQueue,
	FILE_VERSION_RETENTION_MS,
	getStoredFileRow,
	type ExpectedFileHash,
	type FileStorageRow,
} from './sync-storage';

function uploadMutation(
	db: D1Database,
	path: string,
	hash: string,
	size: number,
	objectKey: string,
	expectedHash: ExpectedFileHash,
	operation?: UploadOperation,
	expectedRevision?: string,
): D1PreparedStatement {
	const namespace = fileNamespaceGuard(path);
  const lease = stagedUploadGuard(objectKey);
  namespace.sql += ` AND ${lease.sql}`;
  namespace.args.push(...lease.args);
	if (operation) {
		namespace.sql += ' AND NOT EXISTS (SELECT 1 FROM upload_operations WHERE operation_id = ?)';
		namespace.args.push(operation.id);
	}
	if (expectedHash === null) {
		return db.prepare(`INSERT INTO files (path, portable_path, hash, size, modified, storage_key)
			SELECT ?, ?, ?, ?, datetime('now'), ? WHERE ${namespace.sql}
			ON CONFLICT(path) DO NOTHING`)
			.bind(path, portablePathKey(path), hash, size, objectKey, ...namespace.args);
	}

	const revisionGuard = expectedRevision === undefined ? '' : ' AND storage_key = ?';
	return db.prepare(`UPDATE files
		SET portable_path = ?, hash = ?, size = ?, modified = datetime('now'), storage_key = ?
		WHERE path = ? AND hash = ? AND ${namespace.sql}${revisionGuard}`)
		.bind(portablePathKey(path), hash, size, objectKey, path, expectedHash, ...namespace.args, ...(expectedRevision === undefined ? [] : [expectedRevision]));
}

export interface CommitResult {
	committed: boolean;
	currentHash: string | null;
	revision?: string;
	idempotent?: boolean;
	deletion?: FileDeletionReceipt;
	failure?: UploadResult;
}

export async function commitStagedFile(
	bucket: R2Bucket,
	db: D1Database,
	params: {
		path: string;
		hash: string;
		size: number;
		objectKey: string;
		content: string | ArrayBuffer;
		effects?: CommitEffects;
		operation?: UploadOperation;
		expectedHash: ExpectedFileHash;
		expectedRevision?: string;
		previousFile: FileStorageRow | null;
	},
): Promise<CommitResult> {
	const cleanupKeys = collectCleanupKeys(params.previousFile, params.objectKey);
	const mutation = uploadMutation(
		db,
		params.path,
		params.hash,
		params.size,
		params.objectKey,
		params.expectedHash,
		params.operation,
		params.expectedRevision,
	);
	const results: unknown[] = await db.batch([
		mutation,
		db.prepare(`INSERT INTO changelog (path, action, hash, size, revision)
			SELECT ?, 'put', ?, ?, ?
			WHERE EXISTS (
				SELECT 1 FROM files WHERE path = ? AND storage_key = ?
			)`).bind(params.path, params.hash, params.size, params.objectKey, params.path, params.objectKey),
		...cleanupKeys.map((key) => db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, expires_at)
			SELECT ?, ?, ?, ?, 'replaced', ? WHERE EXISTS (
				SELECT 1 FROM files WHERE path = ? AND storage_key = ?
			)`).bind(
			key,
			params.path,
			params.previousFile?.hash ?? '',
			params.previousFile?.size ?? 0,
			Date.now() + FILE_VERSION_RETENTION_MS,
			params.path,
			params.objectKey,
		)),
		...enqueueFileProjection(db, params.path, params.objectKey, params.content),
		...(params.effects?.([{ path: params.path, storageKey: params.objectKey }]) ?? []),
		finishStagedUpload(db, params.objectKey),
		...(params.operation ? [recordUploadReceipt(db, params.operation, params)] : []),
	]);

	if (params.operation) {
		const receipt = await readUploadReceipt(db, params.operation);
		if (!receipt) throw new Error('Upload receipt is unavailable; retry the same operation');
		if (receipt.revision !== params.objectKey) await deleteBucketObjectsOrQueue(bucket, db, [params.objectKey]);
		return { committed: receipt.success, currentHash: receipt.success ? params.hash : receipt.currentHash ?? null, revision: receipt.revision, ...(!receipt.success ? { failure: receipt } : {}) };
	}

	if (changedRows(results[0]) !== 1) {
		try {
			await assertFileNamespaceAvailable(db, params.path);
		} catch (error) {
			if (error instanceof FileNamespaceConflictError) await deleteBucketObjectsOrQueue(bucket, db, [params.objectKey]);
			throw error;
		}
		const current = await getStoredFileRow(db, params.path);
		if (!params.effects && current?.hash === params.hash) {
			const object = await bucket.get(current.storageKey);
			if (!object || object.size !== current.size || await sha256HexBytes(await object.arrayBuffer()) !== current.hash) {
				throw new Error('Committed file content is unavailable; restore a verified version before retrying');
			}
			await deleteBucketObjectsOrQueue(bucket, db, [params.objectKey]);
			return { committed: true, currentHash: current.hash, revision: current.storageKey, idempotent: true };
		}
		await deleteBucketObjectsOrQueue(bucket, db, [params.objectKey]);
		return { committed: false, currentHash: current?.hash ?? null };
	}

	return { committed: true, currentHash: params.hash, revision: params.objectKey };
}

export async function commitFileDelete(
	_bucket: R2Bucket,
	db: D1Database,
	params: {
		path: string;
		expectedHash: ExpectedFileHash;
		expectedRevision?: string;
		previousFile: FileStorageRow | null;
		audit?: MutationAuditContext;
	},
): Promise<CommitResult> {
	// The caller's verified absent snapshot is a valid linearization point for
	// an idempotent retry. Avoid a no-op mutation batch, and never touch a newer
	// recreation which can arrive after that snapshot.
	if (!params.previousFile) {
		const deletion = await findFileDeletionReceipt(db, params.path, params.expectedHash ?? '', params.expectedRevision ?? '');
		return { committed: true, currentHash: null, idempotent: true, ...(deletion ? { deletion } : {}) };
	}
	const audit = params.audit ?? { requestId: crypto.randomUUID(), deviceId: null, clientSession: null, operationId: null };
	const revision = `__crate__/deletions/${crypto.randomUUID()}`;
	const expectedPredicate = params.expectedHash === null
			? 'path = ? AND 0'
			: 'path = ? AND hash = ? AND storage_key = ?';
	const predicateArgs = params.expectedHash === null
		? [params.path]
		: [params.path, params.expectedHash, params.expectedRevision ?? ''];
	const results: unknown[] = await db.batch([
		db.prepare(`INSERT INTO changelog (path, action, hash, size, revision)
			SELECT path, 'delete', '', 0, ? FROM files WHERE ${expectedPredicate}`)
			.bind(revision, ...predicateArgs),
		db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, expires_at)
			SELECT storage_key, path, hash, size, 'deleted', ? FROM files WHERE ${expectedPredicate}`)
			.bind(Date.now() + FILE_VERSION_RETENTION_MS, ...predicateArgs),
		db.prepare(`DELETE FROM files WHERE ${expectedPredicate}`).bind(...predicateArgs),
		recordFileDeletion(db, params.path, params.expectedHash ?? '', params.expectedRevision ?? '', revision, audit),
		...enqueueFileProjection(db, params.path, null, null),
	]);

	if (changedRows(results[2]) !== 1) {
		const current = await getStoredFileRow(db, params.path);
		if (!current) {
			const deletion = await findFileDeletionReceipt(db, params.path, params.expectedHash ?? '', params.expectedRevision ?? '');
			return { committed: true, currentHash: null, idempotent: true, ...(deletion ? { deletion } : {}) };
		}
		return { committed: false, currentHash: current.hash };
	}

	return { committed: true, currentHash: null, deletion: { revision, consumedRevision: params.expectedRevision ?? '', deleteRequestId: audit.requestId } };
}
