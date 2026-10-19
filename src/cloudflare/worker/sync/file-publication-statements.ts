import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { FILE_VERSION_RETENTION_MS, type FileStorageRow } from './storage';

interface PublishedRevision {
	path: string;
	objectKey: string;
}

export function publishedChangelogStatement(
	db: D1Database,
	file: PublishedRevision & { hash: string; size: number },
): D1PreparedStatement {
	return db.prepare(`INSERT INTO changelog (path, action, hash, size, revision)
		SELECT ?, 'put', ?, ?, ?
		WHERE EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?)`)
		.bind(file.path, file.hash, file.size, file.objectKey, ...filePathArgs(file.path), file.objectKey);
}

/** History belongs to the complete publication, including both files of a move. */
export function retainReplacedVersionStatement(
	db: D1Database,
	previous: FileStorageRow & { path: string },
	requiredRevisions: readonly [PublishedRevision, ...PublishedRevision[]],
): D1PreparedStatement {
	const guard = requiredRevisions.map(() => `EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?)`).join(' AND ');
	return db.prepare(`INSERT OR IGNORE INTO file_versions
		(storage_key, path, hash, size, reason, expires_at)
		SELECT ?, ?, ?, ?, 'replaced', MAX(?, (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000 + ${FILE_VERSION_RETENTION_MS})
		WHERE ${guard}`)
		.bind(previous.storageKey, previous.path, previous.hash, previous.size, Date.now() + FILE_VERSION_RETENTION_MS,
			...requiredRevisions.flatMap(file => [...filePathArgs(file.path), file.objectKey]));
}
