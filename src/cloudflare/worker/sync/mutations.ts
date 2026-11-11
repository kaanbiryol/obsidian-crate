import type { ObjectReference } from '../d1/storage-references';
import { deleteBucketObjectsOrQueue } from '../maintenance/object-cleanup';
import { deletedFileStatements, keepReplacedVersionSql, publishedChangelogStatement } from './file-publication-statements';
import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { descriptorColumn, ENCRYPTION_STATE_SQL, encryptionWriteGuard, parseEncryptionState, prepareEncryptedFileCommit } from '../encryption/state';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { syncResetGenerationGuard } from './reset-generation';
import { stagedUploadGuard, finishStagedUpload } from './staging/staged-uploads';
import { stagedBatchGuard } from './staging/staged-upload-batches';
import { decodeReceipt, readUploadReceipt, recordUploadReceipt, type UploadOperation } from './upload-operations';
import type { UploadResult } from '@/protocol/sync-types';
import { enqueueFileProjection } from '../notifications/projection-queue';
import { readingIndexStatements, type ReadingIndexPolicy } from '../reading/library-index';
import type { CommitEffects } from './commit-effects';
import { allGuards, changedRows, type SqlGuard } from '../d1/db';
import { portablePathKey } from '../../../protocol/portable-path';
import { assertFileNamespaceAvailable, FileNamespaceConflictError, fileNamespaceGuard } from './file-namespace';
import { fileDeletionReceiptStatement, findFileDeletionReceipt, type FileDeletionReceipt } from './file-delete-audit';
import type { MutationAuditContext } from '../http/request-diagnostics';
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
	/** The `descriptor` column of an encrypted file. */
	descriptor?: string | null;
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
	const descriptor = input.descriptor ?? null;
	if (expectedHash === null) {
		const namespace = uploadGuard(input);
		return db.prepare(`INSERT INTO files (path, portable_path, hash, size, modified, storage_key, descriptor)
			SELECT ?, ?, ?, ?, datetime('now'), ?, ? WHERE ${namespace.sql}
			ON CONFLICT(portable_path) DO NOTHING`)
			.bind(path, portablePathKey(path), hash, size, objectKey, descriptor, ...namespace.args);
	}
	const replaced = replacedRow({ ...input, expectedHash });
	return db.prepare(`UPDATE files
		SET portable_path = ?, hash = ?, size = ?, modified = datetime('now'), storage_key = ?, descriptor = ?
		WHERE ${replaced.sql}`)
		.bind(portablePathKey(path), hash, size, objectKey, descriptor, ...replaced.args);
}

/** Runs before the upload's UPDATE in the same batch and reads the live row, so a
 * same-bytes recreate since the caller's snapshot cannot leave its object untracked.
 * Unless `always`, a replaced copy is kept only as `keepReplacedVersionSql` allows;
 * the cleanup statement after it queues a copy that was not kept. */
function retainReplacedUpload(db: D1Database, input: UploadMutationInput, always: boolean): D1PreparedStatement[] {
	if (input.expectedHash === null) return [];
	const replaced = replacedRow({ ...input, expectedHash: input.expectedHash });
	return [db.prepare(`INSERT OR IGNORE INTO file_versions (storage_key, path, hash, size, reason, descriptor, expires_at)
		SELECT storage_key, path, hash, size, 'replaced', descriptor, ${FILE_VERSION_EXPIRES_AT_SQL}
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
/** Server state a Markdown writer otherwise reads for each file it commits. */
export type CommitContext = Pick<StagedFileCommitInput, 'encryptionState' | 'reminderFolder' | 'readingPolicy'>;
export function parseCommitContext(row: CommitContextRow | null): CommitContext {
	return { encryptionState: parseEncryptionState(row?.encryption ?? null), reminderFolder: row?.reminderFolder ?? null,
		readingPolicy: row?.readingFolder ? { folder_path: row.readingFolder } : null };
}

/** One upload's statements, in the order they keep within a batch. `mutationIndex` is
 * the `files` write and a receipt, when the upload has an operation, is last. A caller
 * that commits several uploads together adds the Reading index for all of them itself. */
async function stagedFileStatements(db: D1Database, params: StagedFileCommitInput, readingIndex: boolean): Promise<{ statements: D1PreparedStatement[]; mutationIndex: number; encrypted: boolean }> {
	const encryption = await prepareEncryptedFileCommit(db, params.path, params.content, params.encryptionState);
	const upload: UploadMutationInput = {
		path: params.path, hash: params.hash, size: params.size, objectKey: params.objectKey,
		expectedHash: params.expectedHash, expectedRevision: params.expectedRevision,
		operation: params.operation, encryptionState: encryption.state, descriptor: descriptorColumn(encryption.descriptor),
		resetGeneration: params.resetGeneration,
	};
	const retained = retainReplacedUpload(db, upload, params.keepReplacedVersion === true);
	return { mutationIndex: retained.length, encrypted: Boolean(encryption.state), statements: [
		...retained,
		uploadMutation(db, upload),
		publishedChangelogStatement(db, upload),
		...await enqueueFileProjection(db, params.path, params.objectKey, params.content, { encrypted: Boolean(encryption.state), reminderFolder: params.reminderFolder, size: params.size }),
		...(readingIndex ? await readingIndexStatements(db, [{ path: params.path, storageKey: params.objectKey, hash: params.hash, size: params.size, content: params.content }],
			{ policy: params.readingPolicy, encrypted: Boolean(encryption.state) }) : []),
		...(params.effects?.([{ path: params.path, storageKey: params.objectKey }]) ?? []),
		finishStagedUpload(db, params.objectKey, params.path),
		...(params.operation ? [recordUploadReceipt(db, params.operation, params)] : []),
	] };
}

export async function commitStagedFile(
	bucket: R2Bucket,
	db: D1Database,
	params: StagedFileCommitInput,
): Promise<CommitResult> {
	const plan = await stagedFileStatements(db, params, true);
	return settleStagedFile(bucket, db, params, await db.batch(plan.statements), plan.mutationIndex);
}

/** `commitStagedFile` for several uploads in one transaction and one round trip. Each
 * upload has an operation, so its outcome is its durable receipt: a retry of the same
 * operations, together or one at a time, answers from those receipts. The files share
 * one server state, so the first one's Reading policy serves all. Results keep the
 * order of `files`. */
export async function commitStagedFiles(bucket: R2Bucket, db: D1Database, files: Array<StagedFileCommitInput & { operation: UploadOperation }>): Promise<CommitResult[]> {
	if (!files.length) return [];
	const plans = await Promise.all(files.map(file => stagedFileStatements(db, file, false)));
	const statements: D1PreparedStatement[] = [];
	const ranges = plans.map(plan => {
		const start = statements.length;
		statements.push(...plan.statements);
		return [start, statements.length] as const;
	});
	// Index rows apply only to revisions this batch committed, so they follow every file.
	statements.push(...await readingIndexStatements(db, files.map(file => ({ path: file.path, storageKey: file.objectKey, hash: file.hash, size: file.size, content: file.content })),
		{ policy: files[0]!.readingPolicy, encrypted: plans[0]!.encrypted }));
	const results: unknown[] = await db.batch(statements);
	const commits: CommitResult[] = [];
	// Unpublished uploads are cleaned up together, so a batch of stale uploads stays
	// within the invocation's query budget.
	const unpublished: ObjectReference[] = [];
	for (const [index, file] of files.entries()) commits.push(await settleStagedFile(bucket, db, file, results.slice(...ranges[index]!), plans[index]!.mutationIndex, unpublished));
	await deleteBucketObjectsOrQueue(bucket, db, unpublished);
	return commits;
}

/** Reads one upload's outcome from its statements' `results`. An upload with an operation
 * whose object was not published is added to `unpublished` when the caller cleans up. */
async function settleStagedFile(bucket: R2Bucket, db: D1Database, params: StagedFileCommitInput, results: unknown[], mutationIndex: number,
	unpublished?: ObjectReference[]): Promise<CommitResult> {
	if (params.operation) {
		// RETURNING belongs to the atomic commit. Only a concurrent replay needs a read.
		const recorded = (results[results.length - 1] as { results?: Array<{ response_json: string }> } | undefined)?.results?.[0];
		const receipt = recorded ? decodeReceipt(recorded.response_json) : await readUploadReceipt(db, params.operation);
		if (!receipt) throw new Error('Upload receipt is unavailable; retry the same operation');
		if (receipt.revision !== params.objectKey) {
			const object = { storageKey: params.objectKey, path: params.path };
			if (unpublished) unpublished.push(object); else await deleteBucketObjectsOrQueue(bucket, db, [object]);
		}
		return { committed: receipt.success, currentHash: receipt.success ? params.hash : receipt.currentHash ?? null, revision: receipt.revision, ...(!receipt.success ? { failure: receipt } : {}) };
	}

	if (changedRows(results[mutationIndex]) !== 1) {
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

export interface FileDeleteInput {
	path: string;
	expectedHash: ExpectedFileHash;
	expectedRevision?: string;
	previousFile: FileStorageRow | null;
	audit?: MutationAuditContext;
	/** Statements that commit only with this deletion. */
	effects?: CommitEffects;
	/** The current reminder folder when the caller already read it under the coordinator lock. */
	reminderFolder?: string | null;
	readingPolicy?: ReadingIndexPolicy;
}

/** One deletion's statements, in the order they must keep within a batch. The retained
 * copy, which is also the receipt, is written before the row it copies is deleted.
 * `deleteIndex` is the `files` DELETE. */
async function fileDeleteStatements(db: D1Database, params: FileDeleteInput): Promise<{ statements: D1PreparedStatement[]; deleteIndex: number; deletion: FileDeletionReceipt }> {
	const audit = params.audit ?? { requestId: crypto.randomUUID(), deviceId: null, clientSession: null, operationId: null };
	const revision = `__crate__/deletions/${crypto.randomUUID()}`;
	const expectedPredicate = params.expectedHash === null
			? `${FILE_PATH_MATCH} AND 0`
			: `${FILE_PATH_MATCH} AND hash = ? AND storage_key = ?`;
	const predicateArgs = params.expectedHash === null
		? filePathArgs(params.path)
		: [...filePathArgs(params.path), params.expectedHash, params.expectedRevision ?? ''];
	const recorded = deletedFileStatements(db, expectedPredicate, predicateArgs, revision, audit.requestId);
	return { deleteIndex: recorded.length, deletion: { revision, consumedRevision: params.expectedRevision ?? '', deleteRequestId: audit.requestId }, statements: [
		...recorded,
		db.prepare(`DELETE FROM files WHERE ${expectedPredicate}`).bind(...predicateArgs),
		...await enqueueFileProjection(db, params.path, null, null, { reminderFolder: params.reminderFolder }),
		...await readingIndexStatements(db, [{ path: params.path, storageKey: null }], { policy: params.readingPolicy }),
		...(params.effects?.([{ path: params.path, storageKey: null }]) ?? []),
	] };
}

/** A deletion that matched no row: an earlier delete's retry, or a changed file. */
async function unmatchedFileDelete(db: D1Database, params: FileDeleteInput): Promise<CommitResult> {
	const current = await getStoredFileRow(db, params.path);
	if (current) return { committed: false, currentHash: current.hash };
	const deletion = await findFileDeletionReceipt(db, params.path, params.expectedHash ?? '', params.expectedRevision ?? '');
	return { committed: true, currentHash: null, idempotent: true, ...(deletion ? { deletion } : {}) };
}

export async function commitFileDelete(db: D1Database, params: FileDeleteInput): Promise<CommitResult> {
	// The caller's verified absent snapshot is a valid linearization point for
	// an idempotent retry. Avoid a no-op mutation batch, and never touch a newer
	// recreation which can arrive after that snapshot.
	if (!params.previousFile) {
		const deletion = await findFileDeletionReceipt(db, params.path, params.expectedHash ?? '', params.expectedRevision ?? '');
		return { committed: true, currentHash: null, idempotent: true, ...(deletion ? { deletion } : {}) };
	}
	const plan = await fileDeleteStatements(db, params);
	const results: unknown[] = await db.batch(plan.statements);
	if (changedRows(results[plan.deleteIndex]) !== 1) return unmatchedFileDelete(db, params);
	return { committed: true, currentHash: null, deletion: plan.deletion };
}

/** `commitFileDelete` for several files in one transaction and one round trip. A file
 * the caller's snapshot found absent only reads its earlier receipt. Results keep the
 * order of `deletions`. */
export async function commitFileDeletes(db: D1Database, deletions: FileDeleteInput[]): Promise<CommitResult[]> {
	if (!deletions.length) return [];
	const plans = await Promise.all(deletions.map(async params => params.previousFile ? fileDeleteStatements(db, params) : null));
	const statements: D1PreparedStatement[] = [];
	const starts = plans.map((plan, index) => {
		const start = statements.length, params = deletions[index]!;
		statements.push(...(plan ? plan.statements : [fileDeletionReceiptStatement(db, params.path, params.expectedHash ?? '', params.expectedRevision ?? '')]));
		return start;
	});
	const results: unknown[] = await db.batch(statements);
	return Promise.all(deletions.map(async (params, index): Promise<CommitResult> => {
		const plan = plans[index], start = starts[index]!;
		if (!plan) {
			const deletion = (results[start] as { results?: FileDeletionReceipt[] } | undefined)?.results?.[0];
			return { committed: true, currentHash: null, idempotent: true, ...(deletion ? { deletion } : {}) };
		}
		if (changedRows(results[start + plan.deleteIndex]) !== 1) return unmatchedFileDelete(db, params);
		return { committed: true, currentHash: null, deletion: plan.deletion };
	}));
}
