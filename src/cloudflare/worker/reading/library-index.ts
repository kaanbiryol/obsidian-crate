import { managedArticle } from '@/reading/core/article';
import { parseReadingNote } from '@/reading/core/notes';
import { MAX_READING_BYTES, readingUrlIdentity } from '@/reading/core/model';
import { portablePathKey } from '@/protocol/portable-path';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { sha256Hex } from '@/platform/sha256';
import { FILE_FOLDER_MATCH, fileFolderArgs } from '../sync/file-identity';
import type { Env } from '../types';
import { changedRows } from '../d1/db';
import { isMarkdownNoteInFolder, isMarkdownPath } from '../../../protocol/note-paths';

/** `reading_items` holds one row per Reading note in the Reading folder, written in the
 * same D1 batch as the file commit, so reads never re-check `files`. Only a new scope
 * (folder, generation or format), a restore or an initial import rebuilds it from R2. */
const INDEX_FORMAT = 1;
const REBUILD_PAGE = 25;
const MAX_READING_JOBS = 1000;
export const readingIndexScope = (current: Pick<ReadingPolicy, 'folder_path' | 'generation'>) => `${current.folder_path}\n${current.generation}\n${INDEX_FORMAT}`;

export const READING_SIZE_ERROR = 'Reading notes must be smaller than 1 MB.';
export const READING_ENCODING_ERROR = 'Save this note as UTF-8 to use it in Reading. The original vault file remains synced.';
const READING_PROPERTIES_ERROR = 'This Reading note has invalid properties. Open it in Obsidian to check them.';
export const ARTICLE_EDITED_ERROR = 'Article text was edited. Set extraction_status to ready in Obsidian to keep it as your saved article.';

export type ReadingIndexPolicy = Pick<ReadingPolicy, 'folder_path'> | null;
/** A committed file revision, or a removed path when `storageKey` is null. */
export interface ReadingFileChange { path: string; storageKey: string | null; hash?: string; size?: number; content?: string | ArrayBuffer | null }

export const isReadingNotePath = (path: string, folder: string) => isMarkdownNoteInFolder(path, folder);

/** Keeps a BOM, like `decodeMarkdownBytes`: Worker Reading writes rebuild the note from this text. */
export function decodeReadingNote(bytes: ArrayBuffer | Uint8Array): string | null {
	try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

interface IndexRow {
	path: string; portable: string; storage_key: string | null; keep: 0 | 1;
	hash?: string; size?: number; item_id?: string | null; url_identity?: string | null; url?: string | null;
	metadata_json?: string | null; error?: string | null; article_hash?: string | null; article_edited?: 0 | 1; saved_at?: string;
}

/** The row for a file revision; `keep: 0` when the file is not a Reading note. */
async function indexRow(change: ReadingFileChange): Promise<IndexRow | 'unknown'> {
	const base = { path: change.path, portable: portablePathKey(change.path), storage_key: change.storageKey };
	if (change.storageKey === null) return { ...base, keep: 0 };
	const { hash, size, content } = change;
	if (hash === undefined || size === undefined) return 'unknown';
	const row = { ...base, keep: 1 as const, hash, size };
	if (size > MAX_READING_BYTES) return { ...row, error: READING_SIZE_ERROR };
	if (content == null || typeof content !== 'string' && content.byteLength !== size) return 'unknown';
	const text = typeof content === 'string' ? content : decodeReadingNote(content);
	if (text === null) return { ...row, error: READING_ENCODING_ERROR };
	let metadata: ReturnType<typeof parseReadingNote>;
	try { metadata = parseReadingNote(text); } catch { return { ...row, error: READING_PROPERTIES_ERROR }; }
	if (!metadata) return { ...base, keep: 0 };
	let article_hash: string | null = null, article_edited: 0 | 1 = 0;
	if (metadata.capture_method === 'url' && metadata.extraction_status === 'pending') {
		const block = managedArticle(text);
		if (!block || block.text.trim()) article_edited = 1;
		else article_hash = await sha256Hex(block.text);
	}
	return { ...row, item_id: metadata.crate_reading_id, url_identity: metadata.source_url ? readingUrlIdentity(metadata.source_url) : null, url: metadata.source_url || null,
		metadata_json: JSON.stringify(metadata), article_hash, article_edited, saved_at: metadata.saved_at };
}

/** Statements to place after the file writes in the same batch. Each row change applies
 * only if its file write committed and the Reading folder is still `policy`'s, so a
 * rejected or raced commit leaves the index untouched. Encrypted vaults keep no index. */
export async function readingIndexStatements(db: D1Database, changes: ReadingFileChange[], options: { policy?: ReadingIndexPolicy; encrypted?: boolean; revision?: string } = {}): Promise<D1PreparedStatement[]> {
	if (options.encrypted || !changes.some(change => isMarkdownPath(change.path))) return [];
	const policy = options.policy !== undefined ? options.policy
		: await db.prepare('SELECT folder_path FROM reading_policy WHERE id = 1').first<{ folder_path: string }>();
	if (!policy) return [];
	const rows: IndexRow[] = [];
	for (const change of changes.filter(change => isReadingNotePath(change.path, policy.folder_path))) {
		const row = await indexRow(change);
		// Without the bytes, the only safe outcome is a rebuild from R2.
		if (row === 'unknown') return [db.prepare('DELETE FROM reading_index')];
		rows.push(row);
	}
	if (!rows.length) return [];
	const json = JSON.stringify(rows);
	const committed = `WITH input AS (SELECT json_extract(value, '$.path') AS path, json_extract(value, '$.portable') AS portable,
      json_extract(value, '$.storage_key') AS storage_key, json_extract(value, '$.keep') AS keep, json_extract(value, '$.hash') AS hash,
      json_extract(value, '$.size') AS size, json_extract(value, '$.item_id') AS item_id, json_extract(value, '$.url_identity') AS url_identity,
      json_extract(value, '$.url') AS url, json_extract(value, '$.metadata_json') AS metadata_json, json_extract(value, '$.error') AS error,
      json_extract(value, '$.article_hash') AS article_hash, COALESCE(json_extract(value, '$.article_edited'), 0) AS article_edited,
      COALESCE(json_extract(value, '$.saved_at'), '') AS saved_at FROM json_each(?1)),
    committed AS (SELECT i.* FROM input i WHERE EXISTS (SELECT 1 FROM reading_policy WHERE id = 1 AND folder_path = ?2)
      AND CASE WHEN i.storage_key IS NULL THEN NOT EXISTS (SELECT 1 FROM files f WHERE f.portable_path = i.portable AND f.path = i.path)
        ELSE EXISTS (SELECT 1 FROM files f WHERE f.portable_path = i.portable AND f.path = i.path AND f.storage_key = i.storage_key) END) `;
	const statement = (sql: string, ...args: unknown[]) => db.prepare(committed + sql).bind(json, policy.folder_path, ...args);
	const removes = rows.some(row => !row.keep), keeps = rows.filter(row => row.keep);
	const removed = `portable_path IN (SELECT portable FROM committed WHERE keep = 0 AND storage_key IS NOT NULL)
        OR (portable_path, path) IN (SELECT portable, path FROM committed WHERE storage_key IS NULL)`;
	return [
		// Every row this batch writes, removes or flags takes the next change number. The library
		// revision changes in the same statement, one written row instead of two.
		db.prepare('UPDATE reading_index SET seq = seq + 1, revision = coalesce(?, lower(hex(randomblob(16)))) WHERE id = 1').bind(options.revision ?? null),
		...(removes ? [
			statement(`INSERT INTO reading_removals(path, change_seq, removed_at) SELECT path, ${CHANGE_SEQ}, ?3 FROM reading_items WHERE ${removed}
        ON CONFLICT(path) DO UPDATE SET change_seq = excluded.change_seq, removed_at = excluded.removed_at`, Date.now()),
			statement(`DELETE FROM reading_items WHERE ${removed}`),
			statement('DELETE FROM reading_jobs WHERE path IN (SELECT path FROM committed WHERE keep = 0)'),
		] : []),
		// Fetching runs only for current URL captures; a changed source replaces a waiting job.
		...(keeps.some(row => row.article_hash) ? [statement(`INSERT INTO reading_jobs(path, item_id, generation, source_revision, block_hash, url, available_at)
      SELECT c.path, c.item_id, p.generation, c.storage_key, c.article_hash, c.url, ?3 FROM committed c, reading_policy p
      WHERE p.id = 1 AND p.enabled = 1 AND c.article_hash IS NOT NULL AND (SELECT count(*) FROM reading_jobs) < ${MAX_READING_JOBS}
      ON CONFLICT(path) DO UPDATE SET item_id = excluded.item_id, generation = excluded.generation, source_revision = excluded.source_revision,
        block_hash = excluded.block_hash, url = excluded.url, attempts = 0, available_at = excluded.available_at
      WHERE reading_jobs.source_revision != excluded.source_revision`, Date.now())] : []),
		// Setting an indexed column rewrites its index entry even when the value is the same. So
		// indexed columns change first, and only on rows where they differ; the upsert then sets
		// only unindexed columns and the change number. A favorite rewrites the row and its change
		// number, not every index.
		...(keeps.length ? [
			statement(`UPDATE reading_items SET path = c.path, item_id = c.item_id, url_identity = c.url_identity, saved_at = c.saved_at,
        article_hash = c.article_hash, article_edited = c.article_edited
        FROM committed c WHERE c.keep = 1 AND reading_items.portable_path = c.portable
        AND (reading_items.path, reading_items.item_id, reading_items.url_identity, reading_items.saved_at, reading_items.article_hash, reading_items.article_edited)
          IS NOT (c.path, c.item_id, c.url_identity, c.saved_at, c.article_hash, c.article_edited)`),
			statement(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, url_identity, metadata_json, error, article_hash, article_edited, saved_at, change_seq)
        SELECT portable, path, storage_key, hash, size, item_id, url_identity, metadata_json, error, article_hash, article_edited, saved_at, ${CHANGE_SEQ} FROM committed WHERE keep = 1
        ON CONFLICT(portable_path) DO UPDATE SET storage_key = excluded.storage_key, hash = excluded.hash, size = excluded.size,
          metadata_json = excluded.metadata_json, error = excluded.error, change_seq = excluded.change_seq`),
		] : []),
		// Recount the IDs this batch wrote and every flagged row: a row that changed or left
		// can only end a duplicate, and flagged rows are rare. Each branch uses an index;
		// an OR would scan the table.
		// Only rows whose flag flips change; a flip also changes the listing of an unchanged note.
		db.prepare(`UPDATE reading_items SET duplicate = 1 - duplicate, change_seq = ${CHANGE_SEQ}
      WHERE portable_path IN (SELECT portable_path FROM reading_items WHERE item_id IN (SELECT value FROM json_each(?))
        UNION ALL SELECT portable_path FROM reading_items WHERE duplicate = 1)
        AND duplicate != ((SELECT count(*) FROM reading_items d WHERE d.item_id = reading_items.item_id) > 1)`).bind(JSON.stringify(keeps.flatMap(row => row.item_id ? [row.item_id] : []))),
	];
}

/** The index's current change number; 0 while it has no row, which then rebuilds. */
const CHANGE_SEQ = 'COALESCE((SELECT seq FROM reading_index WHERE id = 1), 0)';
const REMOVAL_RETENTION_MS = 30 * 86400_000;
const REMOVAL_PRUNE_LIMIT = 5000;

/** Drops expired removals and records the newest change they covered, so a delta base
 * from before it relists. Returns true when more expired removals may remain. */
export async function pruneReadingRemovals(db: D1Database, now = Date.now()): Promise<boolean> {
	const expired = `SELECT path, change_seq FROM reading_removals WHERE removed_at < ?1 ORDER BY removed_at LIMIT ${REMOVAL_PRUNE_LIMIT}`;
	const [, deleted] = await db.batch([
		db.prepare(`UPDATE reading_index SET removed_seq = max(removed_seq, COALESCE((SELECT max(change_seq) FROM (${expired})), 0)) WHERE id = 1`).bind(now - REMOVAL_RETENTION_MS),
		db.prepare(`DELETE FROM reading_removals WHERE path IN (SELECT path FROM (${expired}))`).bind(now - REMOVAL_RETENTION_MS),
	]);
	return changedRows(deleted) === REMOVAL_PRUNE_LIMIT;
}

/** Every change to the listed library (notes and the capture queue) advances its ETag. */
export const bumpReadingRevision = (db: D1Database, revision?: string) =>
	db.prepare('UPDATE reading_index SET revision = coalesce(?, lower(hex(randomblob(16)))) WHERE id = 1').bind(revision ?? null);

/** Queue extraction for current URL captures that have no job yet: after fetching is
 * turned on, or once a full queue drains. */
export function queueReadingArticles(db: D1Database): D1PreparedStatement {
	return db.prepare(`INSERT INTO reading_jobs(path, item_id, generation, source_revision, block_hash, url, available_at)
    SELECT i.path, i.item_id, p.generation, i.storage_key, i.article_hash, json_extract(i.metadata_json, '$.source_url'), ? FROM reading_items i, reading_policy p
    WHERE p.id = 1 AND p.enabled = 1 AND i.article_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reading_jobs j WHERE j.path = i.path)
      AND (SELECT count(*) FROM reading_jobs) < ${MAX_READING_JOBS} LIMIT ${MAX_READING_JOBS}
    ON CONFLICT(path) DO NOTHING`).bind(Date.now());
}

export interface StoredReadingFile { path: string; storageKey: string; hash: string; size: number }
/** `rebuilt` marks a call that indexed files, which can queue article extraction. */
/** `epoch`, `seq` and `removedSeq` bound the deltas this index can answer. */
export type ReadingIndexState = { state: 'complete' | 'pending' | 'unavailable'; revision: string; epoch: string; seq: number; removedSeq: number; rebuilt?: boolean };

export interface ReadingIndexRow { scope: string; revision: string; cursor: string | null; epoch: string; seq: number; removedSeq: number }
export const readingIndexStatement = (db: D1Database) => db.prepare('SELECT scope, revision, cursor, epoch, seq, removed_seq AS removedSeq FROM reading_index WHERE id = 1');

/** The state of an index row that is complete for `current`, or null when it must be (re)built. */
export function completeReadingIndex(current: ReadingPolicy, index: ReadingIndexRow | null): ReadingIndexState | null {
	return index?.scope === readingIndexScope(current) && index.cursor === null
		? { state: 'complete', revision: index.revision, epoch: index.epoch, seq: index.seq, removedSeq: index.removedSeq } : null;
}

/** The index state for `current`. While the index is being rebuilt, each call indexes
 * the next files from R2; a failed read keeps the position and reports `unavailable`.
 * `loaded` is the index row when the caller already read it in a batch. */
export async function ensureReadingIndex(env: Env, current: ReadingPolicy, readBytes: (file: StoredReadingFile) => Promise<ArrayBuffer>, loaded?: ReadingIndexRow | null): Promise<ReadingIndexState> {
	const db = env.DB, scope = readingIndexScope(current);
	let index = loaded !== undefined ? loaded : await readingIndexStatement(db).first<ReadingIndexRow>();
	const complete = completeReadingIndex(current, index);
	if (complete) return complete;
	if (index?.scope !== scope) {
		// A new build starts a new epoch, so no delta base from an earlier build applies.
		index = { scope, revision: crypto.randomUUID(), cursor: '', epoch: crypto.randomUUID(), seq: 0, removedSeq: 0 };
		await db.batch([
			db.prepare('DELETE FROM reading_items'),
			db.prepare('DELETE FROM reading_removals'),
			db.prepare('DELETE FROM reading_jobs WHERE generation != ?').bind(current.generation),
			db.prepare(`INSERT INTO reading_index(id, scope, revision, cursor, epoch, seq, removed_seq) VALUES (1, ?, ?, '', ?, 0, 0)
        ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, revision = excluded.revision, cursor = excluded.cursor,
          epoch = excluded.epoch, seq = 0, removed_seq = 0`).bind(scope, index.revision, index.epoch),
		]);
	}
	const { results } = await db.prepare(`SELECT path, portable_path, hash, size, storage_key FROM files WHERE ${FILE_FOLDER_MATCH} AND portable_path > ?
    ORDER BY portable_path LIMIT ${REBUILD_PAGE}`).bind(...fileFolderArgs(current.folder_path), index.cursor ?? '')
		.all<{ path: string; portable_path: string; hash: string; size: number; storage_key: string }>();
	const changes: ReadingFileChange[] = [];
	let cursor = index.cursor ?? '', unavailable = false;
	for (const file of results) {
		if (isReadingNotePath(file.path, current.folder_path)) {
			const change: ReadingFileChange = { path: file.path, storageKey: file.storage_key, hash: file.hash, size: file.size };
			if (file.size <= MAX_READING_BYTES) {
				try { change.content = await readBytes({ path: file.path, storageKey: file.storage_key, hash: file.hash, size: file.size }); }
				catch { unavailable = true; break; }
			}
			changes.push(change);
		}
		cursor = file.portable_path;
	}
	const next = !unavailable && results.length < REBUILD_PAGE ? null : cursor, revision = crypto.randomUUID();
	const written = await db.batch<{ results?: Array<{ seq: number }> }>([
		...await readingIndexStatements(db, changes, { policy: current }),
		db.prepare('UPDATE reading_index SET cursor = ?, revision = ? WHERE id = 1 AND scope = ? RETURNING seq').bind(next, revision, scope),
	]);
	const seq = written.at(-1)?.results?.[0]?.seq ?? 0;
	return { state: unavailable ? 'unavailable' : next === null ? 'complete' : 'pending', revision, epoch: index.epoch, seq, removedSeq: index.removedSeq, rebuilt: true };
}
