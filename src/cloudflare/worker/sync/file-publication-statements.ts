import { portablePathKey } from '../../../protocol/portable-path';
import { fileRevisionGuard, fileRevisionsGuard } from './file-identity';
import { FILE_VERSION_KEPT_AT_SQL, LAST_SEQ_SQL, nextChangelogSeqSql, type FileStorageRow } from './storage';

interface PublishedRevision {
	path: string;
	objectKey: string;
}

export function publishedChangelogStatement(
	db: D1Database,
	file: PublishedRevision & { hash: string; size: number; descriptor?: string | null },
): D1PreparedStatement {
	const revision = fileRevisionGuard(file.path, file.objectKey);
	return db.prepare(`INSERT INTO changelog (seq, path, action, hash, size, revision, descriptor)
		SELECT ${LAST_SEQ_SQL} + 1, ?, 'put', ?, ?, ?, ?
		WHERE ${revision.sql}`)
		.bind(file.path, file.hash, file.size, file.objectKey, file.descriptor ?? null, ...revision.args);
}

/** The delete's changelog row and its history copy for the `files` row `where`
 * selects with `args`. Both must run before that row is deleted. The copy is also the
 * deletion's receipt, naming its `revision` and the server `requestId`. It stops being
 * current at the changelog row written just before it. */
export function deletedFileStatements(db: D1Database, where: string, args: readonly unknown[], revision: string, requestId: string): D1PreparedStatement[] {
	return [
		db.prepare(`INSERT INTO changelog (seq, path, action, hash, size, revision)
			SELECT ${nextChangelogSeqSql('portable_path')}, path, 'delete', '', 0, ? FROM files WHERE ${where}`).bind(revision, ...args),
		db.prepare(`INSERT INTO file_versions (storage_key, path, hash, size, reason, deletion_revision, request_id, descriptor, kept_at, live_from_seq, live_until_seq)
			SELECT storage_key, path, hash, size, 'deleted', ?, ?, descriptor, ${FILE_VERSION_KEPT_AT_SQL}, live_from_seq, ${LAST_SEQ_SQL} FROM files WHERE ${where}
			ON CONFLICT(storage_key) DO UPDATE SET reason = 'deleted', deletion_revision = excluded.deletion_revision,
				request_id = excluded.request_id, kept_at = excluded.kept_at, live_from_seq = excluded.live_from_seq, live_until_seq = excluded.live_until_seq`)
			.bind(revision, requestId, Date.now(), ...args),
	];
}

/** Whether to keep a replaced copy, given the `previous` row's `path` and `live_from_seq`:
 * it was the vault's copy at the latest shared checkpoint, or its path has no copy kept
 * since that checkpoint. A commit adds a checkpoint once the latest is ten minutes old,
 * before its own changes, so this keeps the state before each editing session, the first
 * version of a file created since, and at most one copy per file per checkpoint, and
 * every checkpoint can be rebuilt. */
export function keepReplacedVersionSql(previous: string): string {
	const latest = '(SELECT seq, created_at FROM history_checkpoints ORDER BY seq DESC LIMIT 1)';
	return `(${previous}.live_from_seq <= COALESCE((SELECT seq FROM ${latest}), -1)
		OR NOT EXISTS (SELECT 1 FROM file_versions retained WHERE retained.path = ${previous}.path
			AND retained.created_at >= datetime(COALESCE((SELECT created_at FROM ${latest}), 0) / 1000, 'unixepoch')))`;
}

/** How long a checkpoint stands for the vault: a commit adds one only when the latest is older. */
const CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;

/** Saves the vault as it is now as a shared checkpoint when the latest is older than
 * `CHECKPOINT_INTERVAL_MS`. It runs first in a commit's batch, so the checkpoint falls
 * between transactions and the commit's own copies see it. An empty vault or one still
 * importing gets none. */
export function checkpointStatement(db: D1Database): D1PreparedStatement {
	return db.prepare(`INSERT INTO history_checkpoints (seq, created_at, file_count)
		SELECT current.seq, current.now, current.files
		FROM (SELECT ${LAST_SEQ_SQL} AS seq, CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS now,
			COALESCE((SELECT file_count FROM server_state WHERE id = 1), 0) AS files) AS current
		WHERE current.seq > 0 AND current.files > 0
			AND COALESCE((SELECT import_state FROM server_state WHERE id = 1), 'complete') = 'complete'
			AND NOT EXISTS (SELECT 1 FROM (SELECT seq, created_at FROM history_checkpoints ORDER BY seq DESC LIMIT 1) AS latest
				WHERE latest.seq >= current.seq OR latest.created_at > current.now - ${CHECKPOINT_INTERVAL_MS})
		ON CONFLICT(seq) DO NOTHING`);
}

/** Keeps `server_state.file_count` after a batch: `inserted` files whose new row exists
 * were added, and `deleted` revisions whose deletion receipt exists were removed. Runs
 * after the batch's file writes; storage keys and deletion revisions are new per commit. */
export function fileCountStatement(db: D1Database, inserted: ReadonlyArray<PublishedRevision>, deleted: ReadonlyArray<{ storageKey: string; deletion: string }>): D1PreparedStatement[] {
	if (!inserted.length && !deleted.length) return [];
	return [db.prepare(`INSERT INTO server_state (id, file_count)
		SELECT 1, MAX(0, COALESCE((SELECT file_count FROM server_state WHERE id = 1), 0)
			+ (SELECT COUNT(*) FROM json_each(?) i JOIN files f ON f.portable_path = json_extract(i.value, '$.portable')
				AND f.path = json_extract(i.value, '$.path') AND f.storage_key = json_extract(i.value, '$.key'))
			- (SELECT COUNT(*) FROM json_each(?) i JOIN file_versions v ON v.storage_key = json_extract(i.value, '$.key')
				AND v.deletion_revision = json_extract(i.value, '$.deletion'))) WHERE 1
		ON CONFLICT(id) DO UPDATE SET file_count = excluded.file_count`)
		.bind(JSON.stringify(inserted.map(file => ({ path: file.path, portable: portablePathKey(file.path), key: file.objectKey }))),
			JSON.stringify(deleted.map(file => ({ key: file.storageKey, deletion: file.deletion }))))];
}

/** History belongs to the complete publication, including both files of a move.
 * A copy that is not kept is queued for reference-aware cleanup instead. */
export function retainReplacedVersionStatements(
	db: D1Database,
	previous: FileStorageRow & { path: string; descriptor?: string | null; liveFromSeq: number },
	requiredRevisions: readonly [PublishedRevision, ...PublishedRevision[]],
): D1PreparedStatement[] {
	const guard = fileRevisionsGuard(requiredRevisions.map(file => ({ path: file.path, storageKey: file.objectKey })));
	return [
		// Runs after the publication's changelog rows, so the latest one replaced the copy.
		db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, descriptor, kept_at, live_from_seq, live_until_seq)
			SELECT storage_key, path, hash, size, 'replaced', descriptor, ${FILE_VERSION_KEPT_AT_SQL}, live_from_seq, ${LAST_SEQ_SQL}
			FROM (SELECT ? AS storage_key, ? AS path, ? AS hash, ? AS size, ? AS live_from_seq, ? AS descriptor) AS previous
			WHERE ${guard.sql} AND ${keepReplacedVersionSql('previous')}`)
			.bind(Date.now(), previous.storageKey, previous.path, previous.hash, previous.size,
				previous.liveFromSeq, previous.descriptor ?? null, ...guard.args),
		// Runs after the insert, so it sees whether the copy was kept.
		db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key, file_path)
			SELECT ?, ? WHERE ${guard.sql} AND NOT EXISTS (SELECT 1 FROM file_versions WHERE storage_key = ?)`)
			.bind(previous.storageKey, previous.path, ...guard.args, previous.storageKey),
	];
}
