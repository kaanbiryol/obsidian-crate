import { portablePathKey } from '../../../protocol/portable-path';
import { allGuards, changedRows, type SqlGuard } from '../d1/db';
import { encryptionWriteGuard } from '../encryption/state';
import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from './file-identity';
import { fileNamespaceGuard } from './file-namespace';
import { checkpointStatement, publishedChangelogStatement } from './file-publication-statements';
import { noUploadLeaseGuard } from './staging/upload-leases';
import { LAST_SEQ_SQL, nextChangelogSeqSql } from './storage';

/** A plaintext file to move from `from` to `to`, as the caller's snapshot read it. */
export interface FileMoveInput {
	from: string;
	to: string;
	hash: string;
	size: number;
	storageKey: string;
}

/** What makes moving the row safe, evaluated inside each statement against the source row
 * (`files`):
 * - the destination and its namespace are free;
 * - the vault is plaintext;
 * - no lease or cleanup intent names the key, since both check references at their own path. */
function moveGuard(move: FileMoveInput): SqlGuard {
	return allGuards<string>(
		fileRevisionGuard(move.to, null),
		fileNamespaceGuard(move.to),
		encryptionWriteGuard(null),
		noUploadLeaseGuard(move.storageKey),
		{ sql: 'NOT EXISTS (SELECT 1 FROM object_cleanup_queue q WHERE q.storage_key = ?)', args: [move.storageKey] },
	);
}

/** A move's four statements: the source's delete entry, the row's new path, the
 * destination's put entry and the move's log row. The first two share one predicate and the
 * last two require the moved row, so they all apply or none does. The row keeps its storage
 * key and `live_from_seq`, so no object is written or retained, the file count is unchanged,
 * and the log row (at the put's sequence) lets earlier checkpoints list the copy at its old
 * path. */
function fileMoveStatements(db: D1Database, move: FileMoveInput): D1PreparedStatement[] {
	const guard = moveGuard(move);
	const where = `${FILE_PATH_MATCH} AND hash = ? AND storage_key = ? AND ${guard.sql}`;
	const args = [...filePathArgs(move.from), move.hash, move.storageKey, ...guard.args];
	return [
		db.prepare(`INSERT INTO changelog (seq, path, action, hash, size, revision)
			SELECT ${nextChangelogSeqSql('portable_path')}, path, 'delete', '', 0, ? FROM files WHERE ${where}`)
			.bind(`__crate__/deletions/${crypto.randomUUID()}`, ...args),
		db.prepare(`UPDATE files SET path = ?, portable_path = ? WHERE ${where}`)
			.bind(move.to, portablePathKey(move.to), ...args),
		publishedChangelogStatement(db, { path: move.to, objectKey: move.storageKey, hash: move.hash, size: move.size }),
		db.prepare(`INSERT INTO file_moves (storage_key, seq, from_path, to_portable)
			SELECT storage_key, ${LAST_SEQ_SQL}, ?, portable_path FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?`)
			.bind(move.from, ...filePathArgs(move.to), move.storageKey),
	];
}

/** Commits `moves` in one transaction and returns whether each one applied, in order. A
 * move whose guards failed changed nothing. */
export async function commitFileMoves(db: D1Database, moves: readonly FileMoveInput[]): Promise<boolean[]> {
	if (!moves.length) return [];
	const statements = [checkpointStatement(db), ...moves.flatMap(move => fileMoveStatements(db, move))];
	const results: unknown[] = await db.batch(statements);
	return moves.map((move, index) => {
		const changed = [1, 2, 3, 4].map(offset => changedRows(results[index * 4 + offset]));
		if (changed.every(rows => rows === 1)) return true;
		if (changed.every(rows => rows === 0)) return false;
		throw new Error(`Move of ${move.from} published only part of its rows`);
	});
}
