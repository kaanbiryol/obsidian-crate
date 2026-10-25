import { deleteBucketObjectsOrQueue } from '../maintenance/object-cleanup';
import { publishedChangelogStatement } from './file-publication-statements';
import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from './file-identity';
import { encryptionWriteGuard, prepareEncryptedFileCommit, recordEncryptedFile } from '../encryption/state';
import { stagedUploadGuard, finishStagedUpload } from './staged-uploads';
import { enqueueFileProjection } from '../notifications/projection-queue';
import type { CommitEffects } from '../commit-effects';
import { changedRows } from '../db';
import { portablePathKey } from '../../../protocol/portable-path';
import { stageMarkdownFile } from './markdown-file-staging';
import { FileVersionConflictError } from '../storage';
import { assertFileNamespaceAvailable, fileNamespaceGuard } from './file-namespace';
import { recordFileDeletion, type FileDeletionReceipt } from './file-delete-audit';
import type { MutationAuditContext } from '../request-diagnostics';
import { FILE_VERSION_RETENTION_MS, getStoredFileRow } from './storage';

/** Publish `content` at a new path and delete the exact source revision in one
 * transaction, so a rename never leaves both files or neither. */
export async function writeCommittedMarkdownMove(
	bucket: R2Bucket,
	db: D1Database,
	params: {
		source: { path: string; expectedHash: string; expectedRevision: string };
		destination: { path: string; content: string };
		effects?: CommitEffects;
		audit?: MutationAuditContext;
	},
): Promise<{ hash: string; size: number; revision: string; deletion: FileDeletionReceipt }> {
	const { source } = params;
	if (portablePathKey(source.path) === portablePathKey(params.destination.path)) throw new Error('A move requires two distinct paths');
	const encryption = await prepareEncryptedFileCommit(db, params.destination.path, params.destination.content);
	const destination = await stageMarkdownFile(bucket, db, params.destination.path, params.destination.content, null, Boolean(encryption.state));
	const audit = params.audit ?? { requestId: crypto.randomUUID(), deviceId: null, clientSession: null, operationId: null };
	const deletion = `__crate__/deletions/${crypto.randomUUID()}`;
	const namespace = fileNamespaceGuard(destination.path), lease = stagedUploadGuard(destination.objectKey), guard = encryptionWriteGuard(encryption.state);
	const sourceMatch = `${FILE_PATH_MATCH} AND hash = ? AND storage_key = ?`;
	const sourceArgs = [...filePathArgs(source.path), source.expectedHash, source.expectedRevision];
	const published = fileRevisionGuard(destination.path, destination.objectKey);
	// Every source statement requires the new revision, so it only runs after the insert.
	const sourceStatement = (sql: string, ...args: unknown[]) => db.prepare(`${sql} WHERE ${sourceMatch} AND ${published.sql}`).bind(...args, ...sourceArgs, ...published.args);
	const beforeDelete = [
		db.prepare(`INSERT INTO files (path, portable_path, hash, size, modified, storage_key)
			SELECT ?, ?, ?, ?, datetime('now'), ?
			WHERE EXISTS (SELECT 1 FROM files WHERE ${sourceMatch}) AND ${namespace.sql} AND ${lease.sql} AND ${guard.sql}
			ON CONFLICT(portable_path) DO NOTHING`)
			.bind(destination.path, portablePathKey(destination.path), destination.hash, destination.size, destination.objectKey,
				...sourceArgs, ...namespace.args, ...lease.args, ...guard.args),
		...recordEncryptedFile(db, destination.path, destination.objectKey, encryption.descriptor),
		publishedChangelogStatement(db, destination),
		...await enqueueFileProjection(db, destination.path, destination.objectKey, params.destination.content, false, Boolean(encryption.state)),
		finishStagedUpload(db, destination.objectKey, destination.path),
		sourceStatement(`INSERT INTO changelog (path, action, hash, size, revision) SELECT path, 'delete', '', 0, ? FROM files`, deletion),
		sourceStatement(`INSERT OR IGNORE INTO file_versions (storage_key, path, hash, size, reason, expires_at)
			SELECT storage_key, path, hash, size, 'deleted', MAX(?, (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000 + ${FILE_VERSION_RETENTION_MS}) FROM files`,
		Date.now() + FILE_VERSION_RETENTION_MS),
	];
	const results: unknown[] = await db.batch([
		...beforeDelete,
		sourceStatement('DELETE FROM files'),
		// Must directly follow the delete's changelog row.
		recordFileDeletion(db, source.path, source.expectedHash, source.expectedRevision, deletion, audit),
		...await enqueueFileProjection(db, source.path, null, null),
		...(params.effects?.([{ path: destination.path, storageKey: destination.objectKey }]) ?? []),
	]);
	const inserted = changedRows(results[0]) === 1, removed = changedRows(results[beforeDelete.length]) === 1;
	if (inserted !== removed) throw new Error('A move committed only one file');
	if (!inserted) {
		await deleteBucketObjectsOrQueue(bucket, db, [{ storageKey: destination.objectKey, path: destination.path }]);
		await assertFileNamespaceAvailable(db, destination.path);
		const current = await getStoredFileRow(db, source.path);
		if (current?.hash !== source.expectedHash || current.storageKey !== source.expectedRevision) throw new FileVersionConflictError(source.path, current?.hash ?? null);
		throw new FileVersionConflictError(destination.path, (await getStoredFileRow(db, destination.path))?.hash ?? null);
	}
	return { hash: destination.hash, size: destination.size, revision: destination.objectKey,
		deletion: { revision: deletion, consumedRevision: source.expectedRevision, deleteRequestId: audit.requestId } };
}
