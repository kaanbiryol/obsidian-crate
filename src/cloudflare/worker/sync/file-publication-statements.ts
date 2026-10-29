import { fileRevisionGuard, fileRevisionsGuard } from './file-identity';
import { FILE_VERSION_EXPIRES_AT_SQL, FILE_VERSION_RETENTION_MS, type FileStorageRow } from './storage';

interface PublishedRevision {
	path: string;
	objectKey: string;
}

export function publishedChangelogStatement(
	db: D1Database,
	file: PublishedRevision & { hash: string; size: number },
): D1PreparedStatement {
	const revision = fileRevisionGuard(file.path, file.objectKey);
	return db.prepare(`INSERT INTO changelog (path, action, hash, size, revision)
		SELECT ?, 'put', ?, ?, ?
		WHERE ${revision.sql}`)
		.bind(file.path, file.hash, file.size, file.objectKey, ...revision.args);
}

const LARGE_VERSION_BYTES = 1024 * 1024;

/** Whether to keep a replaced copy, given the `previous` row's `path`, `size` and
 * `modified`. Saves are coalesced: a copy is kept if it was live for a whole window,
 * which keeps the state before each editing session, or if its path has no version
 * retained within the window, which keeps one version per window while editing.
 * Files of 1 MiB or more use a 60-minute window instead of 10 minutes. */
export function keepReplacedVersionSql(previous: string): string {
	const since = `datetime('now', CASE WHEN ${previous}.size >= ${LARGE_VERSION_BYTES} THEN '-60 minutes' ELSE '-10 minutes' END)`;
	return `(${previous}.modified <= ${since} OR NOT EXISTS (SELECT 1 FROM file_versions retained
		WHERE retained.path = ${previous}.path AND retained.created_at > ${since}))`;
}

/** History belongs to the complete publication, including both files of a move.
 * A copy that is not kept is queued for reference-aware cleanup instead. */
export function retainReplacedVersionStatements(
	db: D1Database,
	previous: FileStorageRow & { path: string; modified: string },
	requiredRevisions: readonly [PublishedRevision, ...PublishedRevision[]],
): D1PreparedStatement[] {
	const guard = fileRevisionsGuard(requiredRevisions.map(file => ({ path: file.path, storageKey: file.objectKey })));
	return [
		db.prepare(`INSERT OR IGNORE INTO file_versions
			(storage_key, path, hash, size, reason, expires_at)
			SELECT storage_key, path, hash, size, 'replaced', ${FILE_VERSION_EXPIRES_AT_SQL}
			FROM (SELECT ? AS storage_key, ? AS path, ? AS hash, ? AS size, ? AS modified) AS previous
			WHERE ${guard.sql} AND ${keepReplacedVersionSql('previous')}`)
			.bind(Date.now() + FILE_VERSION_RETENTION_MS, previous.storageKey, previous.path, previous.hash, previous.size,
				previous.modified, ...guard.args),
		// Runs after the insert, so it sees whether the copy was kept.
		db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key, file_path)
			SELECT ?, ? WHERE ${guard.sql} AND NOT EXISTS (SELECT 1 FROM file_versions WHERE storage_key = ?)`)
			.bind(previous.storageKey, previous.path, ...guard.args, previous.storageKey),
	];
}
