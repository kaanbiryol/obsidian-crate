import { deleteBucketObjectsOrQueue } from '../maintenance/object-cleanup';
import { keepReplacedVersionSql, publishedChangelogStatement } from './file-publication-statements';
import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { ENCRYPTION_STATE_SQL, encryptionWriteGuard, parseEncryptionState, prepareEncryptedFileCommit, recordEncryptedFile } from '../encryption/state';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { syncResetGenerationGuard } from './reset-generation';
import { stagedUploadGuard, finishStagedUpload } from './staging/staged-uploads';
import { stagedBatchGuard } from './staging/staged-upload-batches';
import { decodeReceipt, readUploadReceipt, recordUploadReceipt, type UploadOperation } from './upload-operations';
import type { UploadResult } from '@/protocol/sync-types';
import { enqueueFileProjection } from '../notifications/projection-queue';
import { readingIndexStatements, type ReadingIndexPolicy } from '../reading/library-index';
import type { CommitEffects } from '../commit-effects';
import { allGuards, changedRows, type SqlGuard } from '../db';
import { portablePathKey } from '../../../protocol/portable-path';
import { assertFileNamespaceAvailable, FileNamespaceConflictError, fileNamespaceGuard } from './file-namespace';
import { findFileDeletionReceipt, recordFileDeletion, type FileDeletionReceipt } from './file-delete-audit';
import type { MutationAuditContext } from '../request-diagnostics';
import {
	FILE_VERSION_EXPIRES_AT_SQL,
	FILE_VERSION_RETENTION_MS,
	getStoredFileRow,
	readVerifiedBytes,
	type ExpectedFileHash,
	type FileStorageRow,
} from './storage';

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
}: UploadMutationInput): SqlGuard {
	return allGuards(
		fileNamespaceGuard(path),
		encryptionWriteGuard(encryptionState),
		syncResetGenerationGuard(resetGeneration),
		stagingBatchId ? stagedBatchGuard(stagingBatchId, objectKey) : stagedUploadGuard(objectKey),
		...importToken ? [{ sql: "EXISTS (SELECT 1 FROM initial_import WHERE token = ? AND state = 'importing')", args: [importToken] }] : [],
		...operation ? [{ sql: 'NOT EXISTS (SELECT 1 FROM upload_operations WHERE operation_id = ?)', args: [operation.id] }] : [],
	);
}

/** The row an update replaces: exactly what its UPDATE matches. */
function replacedRow(input: UploadMutationInput & { expectedHash: string }): SqlGuard {
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
 * same-bytes recreate since the caller's snapshot cannot leave its object untracked.
 * Unless `always`, a replaced copy is kept only as `keepReplacedVersionSql` allows;
 * the cleanup statement after it queues a copy that was not kept. */
function retainReplacedUpload(db: D1Database, input: UploadMutationInput, always: boolean): D1PreparedStatement[] {
	if (input.expectedHash === null) return [];
	const replaced = replacedRow({ ...input, expectedHash: input.expectedHash });
	return [db.prepare(`INSERT OR IGNORE INTO file_versions (storage_key, path, hash, size, reason, expires_at)
		SELECT storage_key, path, hash, size, 'replaced', ${FILE_VERSION_EXPIRES_AT_SQL}
		FROM files WHERE ${replaced.sql} AND storage_key != ?${always ? '' : ` AND ${keepReplacedVersionSql('files')}`}`)
		.bind(Date.now() + FILE_VERSION_RETENTION_MS, ...replaced.args, input.objectKey),
	...queueReplacedUploadCleanup(db, input)];
}

/** Queues the object an upload replaces for reference-aware cleanup unless a
 * retained version keeps it. Writers that keep no versions use this alone. */
export function queueReplacedUploadCleanup(db: D1Database, input: UploadMutationInput): D1PreparedStatement[] {
	if (input.expectedHash === null) return [];
	const replaced = replacedRow({ ...input, expectedHash: input.expectedHash });
	return [db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key, file_path)
		SELECT storage_key, path FROM files WHERE ${replaced.sql} AND storage_key != ?
		AND NOT EXISTS (SELECT 1 FROM file_versions WHERE storage_key = files.storage_key)`)
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
	/** The library revision this commit publishes, when the caller reports it. */
	readingRevision?: string;
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
	/** Keep the replaced copy without coalescing, so an explicit restore can be undone. */
	keepReplacedVersion?: boolean;
}

/** Columns for `parseCommitContext`: the server state `commitStagedFile` otherwise
 * reads in three statements. Read them under the coordinator lock, which serializes
 * the writers of these rows. */
export const COMMIT_CONTEXT_COLUMNS = `${ENCRYPTION_STATE_SQL} AS encryption,
    (SELECT folder_path FROM notification_policy WHERE id = 1) AS reminderFolder,
    (SELECT folder_path FROM reading_policy WHERE id = 1) AS readingFolder`;
export interface CommitContextRow { encryption: string | null; reminderFolder: string | null; readingFolder: string | null }
export function parseCommitContext(row: CommitContextRow | null): Pick<StagedFileCommitInput, 'encryptionState' | 'reminderFolder' | 'readingPolicy'> {
	return { encryptionState: parseEncryptionState(row?.encryption ?? null), reminderFolder: row?.reminderFolder ?? null,
		readingPolicy: row?.readingFolder ? { folder_path: row.readingFolder } : null };
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
	const retained = retainReplacedUpload(db, upload, params.keepReplacedVersion === true);
	const results: unknown[] = await db.batch([
		...retained,
		uploadMutation(db, upload),
		...recordEncryptedFile(db, params.path, params.objectKey, encryption.descriptor),
		publishedChangelogStatement(db, params),
		...await enqueueFileProjection(db, params.path, params.objectKey, params.content, false, Boolean(encryption.state), params.reminderFolder, params.size),
		...await readingIndexStatements(db, [{ path: params.path, storageKey: params.objectKey, hash: params.hash, size: params.size, content: params.content }],
			{ policy: params.readingPolicy, encrypted: Boolean(encryption.state), revision: params.readingRevision }),
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
			if (!await readVerifiedBytes(bucket, current)) {
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
			SELECT storage_key, path, hash, size, 'deleted', ${FILE_VERSION_EXPIRES_AT_SQL} FROM files WHERE ${expectedPredicate}`)
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
