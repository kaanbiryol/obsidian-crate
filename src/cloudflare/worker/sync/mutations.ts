import { deleteBucketObjectsOrQueue } from '../maintenance/object-cleanup';
import { publishedChangelogStatement } from './file-publication-statements';
import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { encryptionWriteGuard, prepareEncryptedFileCommit, recordEncryptedFile } from '../encryption/state';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { syncResetGenerationGuard } from './reset-generation';
import { stagedUploadGuard, finishStagedUpload } from './staging/staged-uploads';
import { stagedBatchGuard } from './staging/staged-upload-batches';
import { decodeReceipt, readUploadReceipt, recordUploadReceipt, type UploadOperation } from './upload-operations';
import type { UploadResult } from '@/protocol/sync-types';
import { enqueueFileProjection } from '../notifications/projection-queue';
import { readingIndexStatements, type ReadingIndexPolicy } from '../reading/library-index';
import type { CommitEffects } from '../commit-effects';
import { changedRows } from '../db';
import { portablePathKey } from '../../../protocol/portable-path';
import { assertFileNamespaceAvailable, FileNamespaceConflictError, fileNamespaceGuard } from './file-namespace';
import { findFileDeletionReceipt, recordFileDeletion, type FileDeletionReceipt } from './file-delete-audit';
import type { MutationAuditContext } from '../request-diagnostics';
import {
	FILE_VERSION_RETENTION_MS,
	getStoredFileRow,
	type ExpectedFileHash,
	type FileStorageRow,
} from './storage';
import { sha256Hex } from '@/platform/sha256';

interface UploadMutationInput {
	path: string;
	hash: string;
	size: number;
	objectKey: string;
	expectedHash: ExpectedFileHash;
	operation?: UploadOperation;
	expectedRevision?: string;
	stagingBatchId?: string;
	importToken?: string;
	encryptionState?: EncryptionServerState | null;
	resetGeneration?: string | null;
}

function uploadGuard({
	path, objectKey, operation, stagingBatchId, importToken, encryptionState = null, resetGeneration,
}: UploadMutationInput): { sql: string; args: unknown[] } {
	const namespace = fileNamespaceGuard(path);
	const encryption = encryptionWriteGuard(encryptionState);
	namespace.sql += ` AND ${encryption.sql}`;
	namespace.args.push(...encryption.args);
	const resetGuard = syncResetGenerationGuard(resetGeneration);
	namespace.sql += ` AND ${resetGuard.sql}`;
	namespace.args.push(...resetGuard.args);
  const lease = stagingBatchId ? stagedBatchGuard(stagingBatchId, objectKey) : stagedUploadGuard(objectKey);
  namespace.sql += ` AND ${lease.sql}`;
  namespace.args.push(...lease.args);
  if (importToken) {
    namespace.sql += " AND EXISTS (SELECT 1 FROM initial_import WHERE token = ? AND state = 'importing')";
    namespace.args.push(importToken);
  }
	if (operation) {
		namespace.sql += ' AND NOT EXISTS (SELECT 1 FROM upload_operations WHERE operation_id = ?)';
		namespace.args.push(operation.id);
	}
	return namespace;
}

/** The row an update replaces: exactly what its UPDATE matches. */
function replacedRow(input: UploadMutationInput & { expectedHash: string }): { sql: string; args: unknown[] } {
	const namespace = uploadGuard(input);
	const revisionGuard = input.expectedRevision === undefined ? '' : ' AND storage_key = ?';
	return {
		sql: `${FILE_PATH_MATCH} AND hash = ? AND ${namespace.sql}${revisionGuard}`,
		args: [...filePathArgs(input.path), input.expectedHash, ...namespace.args, ...(input.expectedRevision === undefined ? [] : [input.expectedRevision])],
	};
}

export function uploadMutation(db: D1Database, input: UploadMutationInput): D1PreparedStatement {
	const { path, hash, size, objectKey, expectedHash } = input;
	if (expectedHash === null) {
		const namespace = uploadGuard(input);
		return db.prepare(`INSERT INTO files (path, portable_path, hash, size, modified, storage_key)
			SELECT ?, ?, ?, ?, datetime('now'), ? WHERE ${namespace.sql}
			ON CONFLICT(portable_path) DO NOTHING`)
			.bind(path, portablePathKey(path), hash, size, objectKey, ...namespace.args);
	}
	const replaced = replacedRow({ ...input, expectedHash });
	return db.prepare(`UPDATE files
		SET portable_path = ?, hash = ?, size = ?, modified = datetime('now'), storage_key = ?
		WHERE ${replaced.sql}`)
		.bind(portablePathKey(path), hash, size, objectKey, ...replaced.args);
}

/** Runs before the upload's UPDATE in the same batch and reads the live row, so a
 * same-bytes recreate since the caller's snapshot cannot leave its object untracked. */
function retainReplacedUpload(db: D1Database, input: UploadMutationInput): D1PreparedStatement[] {
	if (input.expectedHash === null) return [];
	const replaced = replacedRow({ ...input, expectedHash: input.expectedHash });
	return [db.prepare(`INSERT OR IGNORE INTO file_versions (storage_key, path, hash, size, reason, expires_at)
		SELECT storage_key, path, hash, size, 'replaced', MAX(?, (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000 + ${FILE_VERSION_RETENTION_MS})
		FROM files WHERE ${replaced.sql} AND storage_key != ?`)
		.bind(Date.now() + FILE_VERSION_RETENTION_MS, ...replaced.args, input.objectKey)];
}

/** Like retainReplacedUpload, for writers that clean up replaced objects instead of keeping versions. */
export function queueReplacedUploadCleanup(db: D1Database, input: UploadMutationInput): D1PreparedStatement[] {
	if (input.expectedHash === null) return [];
	const replaced = replacedRow({ ...input, expectedHash: input.expectedHash });
	return [db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key, file_path)
		SELECT storage_key, path FROM files WHERE ${replaced.sql} AND storage_key != ?`)
		.bind(...replaced.args, input.objectKey)];
}

export interface CommitResult {
	committed: boolean;
	currentHash: string | null;
	revision?: string;
	idempotent?: boolean;
	deletion?: FileDeletionReceipt;
	failure?: UploadResult;
}

export interface StagedFileCommitInput {
	reminderPolicyRevision?: string | null;
	/** The current reminder folder when the caller already read it under the coordinator lock. */
	reminderFolder?: string | null;
	/** The current Reading policy when the caller already read it. */
	readingPolicy?: ReadingIndexPolicy;
	path: string;
	hash: string;
	size: number;
	objectKey: string;
	content: string | ArrayBuffer;
	effects?: CommitEffects;
	encryptionState?: EncryptionServerState | null;
	resetGeneration?: string | null;
	operation?: UploadOperation;
	expectedHash: ExpectedFileHash;
	expectedRevision?: string;
	/** Only the server's own Reading capture sets this: a new note sealed to the
	 * vault seal key inside this folder. Client uploads can never create one. */
	sealedReadingFolder?: string;
}

export async function commitStagedFile(
	bucket: R2Bucket,
	db: D1Database,
	params: StagedFileCommitInput,
): Promise<CommitResult> {
	if (params.sealedReadingFolder !== undefined && params.expectedHash !== null) throw new Error('Sealed notes can only be created');
	const encryption = await prepareEncryptedFileCommit(db, params.path, params.content, params.encryptionState,
		params.sealedReadingFolder === undefined ? undefined : { readingFolder: params.sealedReadingFolder });
	const upload: UploadMutationInput = {
		path: params.path, hash: params.hash, size: params.size, objectKey: params.objectKey,
		expectedHash: params.expectedHash, expectedRevision: params.expectedRevision,
		operation: params.operation, encryptionState: encryption.state, resetGeneration: params.resetGeneration,
	};
	const retained = retainReplacedUpload(db, upload);
	const results: unknown[] = await db.batch([
		...retained,
		uploadMutation(db, upload),
		...recordEncryptedFile(db, params.path, params.objectKey, encryption.descriptor),
		publishedChangelogStatement(db, params),
		...await enqueueFileProjection(db, params.path, params.objectKey, params.content, false, Boolean(encryption.state), params.reminderFolder),
		...await readingIndexStatements(db, [{ path: params.path, storageKey: params.objectKey, hash: params.hash, size: params.size, content: params.content }],
			{ policy: params.readingPolicy, encrypted: Boolean(encryption.state) }),
		...(params.effects?.([{ path: params.path, storageKey: params.objectKey }]) ?? []),
		finishStagedUpload(db, params.objectKey, params.path),
		...(params.operation ? [recordUploadReceipt(db, params.operation, params)] : []),
	]);

	if (params.operation) {
		// RETURNING belongs to the atomic commit. Only a concurrent replay needs a read.
		const recorded = (results[results.length - 1] as { results?: Array<{ response_json: string }> } | undefined)?.results?.[0];
		const receipt = recorded ? decodeReceipt(recorded.response_json) : await readUploadReceipt(db, params.operation);
		if (!receipt) throw new Error('Upload receipt is unavailable; retry the same operation');
		if (receipt.revision !== params.objectKey) await deleteBucketObjectsOrQueue(bucket, db, [{ storageKey: params.objectKey, path: params.path }]);
		return { committed: receipt.success, currentHash: receipt.success ? params.hash : receipt.currentHash ?? null, revision: receipt.revision, ...(!receipt.success ? { failure: receipt } : {}) };
	}

	if (changedRows(results[retained.length]) !== 1) {
		try {
			await assertFileNamespaceAvailable(db, params.path);
		} catch (error) {
			if (error instanceof FileNamespaceConflictError) await deleteBucketObjectsOrQueue(bucket, db, [{ storageKey: params.objectKey, path: params.path }]);
			throw error;
		}
		const current = await getStoredFileRow(db, params.path);
		if (!params.effects && current?.hash === params.hash) {
			const object = await bucket.get(current.storageKey);
			if (!object || object.size !== current.size || await sha256Hex(await object.arrayBuffer()) !== current.hash) {
				throw new Error('Committed file content is unavailable; restore a verified version before retrying');
			}
			await deleteBucketObjectsOrQueue(bucket, db, [{ storageKey: params.objectKey, path: params.path }]);
			return { committed: true, currentHash: current.hash, revision: current.storageKey, idempotent: true };
		}
		await deleteBucketObjectsOrQueue(bucket, db, [{ storageKey: params.objectKey, path: params.path }]);
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
			? `${FILE_PATH_MATCH} AND 0`
			: `${FILE_PATH_MATCH} AND hash = ? AND storage_key = ?`;
	const predicateArgs = params.expectedHash === null
		? filePathArgs(params.path)
		: [...filePathArgs(params.path), params.expectedHash, params.expectedRevision ?? ''];
	const results: unknown[] = await db.batch([
		db.prepare(`INSERT INTO changelog (path, action, hash, size, revision)
			SELECT path, 'delete', '', 0, ? FROM files WHERE ${expectedPredicate}`)
			.bind(revision, ...predicateArgs),
		db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, expires_at)
			SELECT storage_key, path, hash, size, 'deleted', MAX(?, (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000 + ${FILE_VERSION_RETENTION_MS}) FROM files WHERE ${expectedPredicate}`)
			.bind(Date.now() + FILE_VERSION_RETENTION_MS, ...predicateArgs),
		db.prepare(`DELETE FROM files WHERE ${expectedPredicate}`).bind(...predicateArgs),
		recordFileDeletion(db, params.path, params.expectedHash ?? '', params.expectedRevision ?? '', revision, audit),
		...await enqueueFileProjection(db, params.path, null, null),
		...await readingIndexStatements(db, [{ path: params.path, storageKey: null }]),
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
