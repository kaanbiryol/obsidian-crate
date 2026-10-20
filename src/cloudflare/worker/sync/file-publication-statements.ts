import { fileRevisionGuard, fileRevisionsGuard } from './file-identity';
import { FILE_VERSION_RETENTION_MS, type FileStorageRow } from './storage';

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

/** History belongs to the complete publication, including both files of a move. */
export function retainReplacedVersionStatement(
	db: D1Database,
	previous: FileStorageRow & { path: string },
	requiredRevisions: readonly [PublishedRevision, ...PublishedRevision[]],
): D1PreparedStatement {
	const guard = fileRevisionsGuard(requiredRevisions.map(file => ({ path: file.path, storageKey: file.objectKey })));
	return db.prepare(`INSERT OR IGNORE INTO file_versions
		(storage_key, path, hash, size, reason, expires_at)
		SELECT ?, ?, ?, ?, 'replaced', MAX(?, (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000 + ${FILE_VERSION_RETENTION_MS})
		WHERE ${guard.sql}`)
		.bind(previous.storageKey, previous.path, previous.hash, previous.size, Date.now() + FILE_VERSION_RETENTION_MS,
			...guard.args);
}
