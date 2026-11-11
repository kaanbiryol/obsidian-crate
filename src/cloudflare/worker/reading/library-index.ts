import { managedArticle } from '@/reading/core/article';
import { parseReadingNote } from '@/reading/core/notes';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { readingTerms, searchWords } from '@/reading/core/search-terms';
import { isReadingCardKind, validateReadingCardData, type ReadingCardData } from '@/reading/core/reading-card';
import { parseEncryptedFile } from '@/encryption/file-format';
import { MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES } from '@/encryption/file-inventory';
import { portablePathKey } from '@/protocol/portable-path';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { sha256Hex } from '@/platform/sha256';
import { FILE_FOLDER_MATCH, fileFolderArgs } from '../sync/file-identity';
import type { Env } from '../types';
import { isMarkdownNoteInFolder, isMarkdownPath } from '../../../protocol/note-paths';

/** `reading_items` holds one row per Reading note in the Reading folder, written in the
 * same D1 batch as the file commit, so reads never re-check `files`. Only a new scope
 * (folder, generation or format), a restore or an initial import rebuilds it from R2. */
const INDEX_FORMAT = 2;
/** The upsert's unindexed columns for a note with a current card or metadata, from `committed c`. */
const UNINDEXED = `storage_key = c.storage_key, hash = c.hash, size = c.size, metadata_json = c.metadata_json,
        error = c.error, words = c.words, terms = c.terms, card = c.card`;
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
	hash?: string; size?: number; item_id?: string | null; url?: string | null;
	metadata_json?: string | null; error?: string | null; article_hash?: string | null; article_edited?: 0 | 1; saved_at?: string;
	status?: string | null; favorite?: 0 | 1; highlighted?: 0 | 1; terms?: string | null;
	/** An unencrypted note's title words, which confirm a search's candidates. */
	words?: string | null;
	/** An encrypted note's card from its public data, as JSON `{ card }`. */
	card?: string | null;
	/** An encrypted note whose upload carried no card: the row keeps its last one. */
	stale?: 0 | 1;
}

/** The Reading card an encrypted upload carries as its public data, or null. */
function encryptedCard(content: string | ArrayBuffer | null | undefined): ReadingCardData | null {
	if (content == null) return null;
	try {
		const { publicData } = parseEncryptedFile(typeof content === 'string' ? content : new Uint8Array(content));
		if (!isReadingCardKind(publicData)) return null;
		validateReadingCardData(publicData);
		return publicData;
	} catch { return null; }
}

const ENCRYPTED_FILE_PREFIX = new TextEncoder().encode('CRATE-E2EE/1\n');
function isEncryptedContent(content: string | ArrayBuffer | null | undefined): boolean {
	if (content == null) return false;
	if (typeof content === 'string') return content.startsWith('CRATE-E2EE/1\n');
	const bytes = new Uint8Array(content, 0, Math.min(content.byteLength, ENCRYPTED_FILE_PREFIX.length));
	return bytes.length === ENCRYPTED_FILE_PREFIX.length && bytes.every((byte, index) => byte === ENCRYPTED_FILE_PREFIX[index]);
}

/** The row for a file revision; `keep: 0` when the file is not a Reading note. */
async function indexRow(change: ReadingFileChange, encrypted: boolean): Promise<IndexRow | 'unknown'> {
	const base = { path: change.path, portable: portablePathKey(change.path), storage_key: change.storageKey };
	if (change.storageKey === null) return { ...base, keep: 0 };
	const { hash, size, content } = change;
	if (hash === undefined || size === undefined) return 'unknown';
	const row = { ...base, keep: 1 as const, hash, size };
	// The server cannot read an encrypted note; the device that encrypted it attached its card.
	if (encrypted || isEncryptedContent(content)) {
		const data = encryptedCard(content);
		if (!data) return { ...row, stale: 1 };
		const { fields } = data;
		return { ...row, item_id: fields.item_id, saved_at: fields.saved_at, status: fields.status, favorite: fields.favorite ? 1 : 0, highlighted: fields.highlighted ? 1 : 0,
			terms: JSON.stringify(data.terms), card: JSON.stringify({ card: data.card }) };
	}
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
	return { ...row, item_id: metadata.crate_reading_id, url: metadata.source_url || null,
		metadata_json: JSON.stringify(metadata), article_hash, article_edited, saved_at: metadata.saved_at,
		status: metadata.reading_status, favorite: metadata.favorite ? 1 : 0, highlighted: metadata.highlights?.length ? 1 : 0,
		terms: JSON.stringify(readingTerms(metadata)), words: JSON.stringify(searchWords(metadata.title)) };
}

/** Statements to place after the file writes in the same batch. Each row change applies
 * only if its file write committed and the Reading folder is still `policy`'s, so a
 * rejected or raced commit leaves the index untouched. In an encrypted vault, each row comes
 * from the card the device attached to the note's upload. */
export async function readingIndexStatements(db: D1Database, changes: ReadingFileChange[], options: { policy?: ReadingIndexPolicy; encrypted?: boolean } = {}): Promise<D1PreparedStatement[]> {
	if (!changes.some(change => isMarkdownPath(change.path))) return [];
	const policy = options.policy !== undefined ? options.policy
		: await db.prepare('SELECT folder_path FROM reading_policy WHERE id = 1').first<{ folder_path: string }>();
	if (!policy) return [];
	const rows: IndexRow[] = [];
	for (const change of changes.filter(change => isReadingNotePath(change.path, policy.folder_path))) {
		const row = await indexRow(change, options.encrypted === true);
		// Without the bytes, the only safe outcome is a rebuild from R2.
		if (row === 'unknown') return [db.prepare('DELETE FROM reading_index')];
		rows.push(row);
	}
	if (!rows.length) return [];
	const json = JSON.stringify(rows);
	const committed = `WITH input AS (SELECT json_extract(value, '$.path') AS path, json_extract(value, '$.portable') AS portable,
      json_extract(value, '$.storage_key') AS storage_key, json_extract(value, '$.keep') AS keep, json_extract(value, '$.hash') AS hash,
      json_extract(value, '$.size') AS size, json_extract(value, '$.item_id') AS item_id,
      json_extract(value, '$.url') AS url, json_extract(value, '$.metadata_json') AS metadata_json, json_extract(value, '$.error') AS error,
      json_extract(value, '$.article_hash') AS article_hash, COALESCE(json_extract(value, '$.article_edited'), 0) AS article_edited,
      COALESCE(json_extract(value, '$.saved_at'), '') AS saved_at, json_extract(value, '$.status') AS status,
      COALESCE(json_extract(value, '$.favorite'), 0) AS favorite, COALESCE(json_extract(value, '$.highlighted'), 0) AS highlighted,
      json_extract(value, '$.terms') AS terms, json_extract(value, '$.words') AS words, json_extract(value, '$.card') AS card,
      COALESCE(json_extract(value, '$.stale'), 0) AS stale FROM json_each(?1)),
    committed AS (SELECT i.* FROM input i WHERE EXISTS (SELECT 1 FROM reading_policy WHERE id = 1 AND folder_path = ?2)
      AND CASE WHEN i.storage_key IS NULL THEN NOT EXISTS (SELECT 1 FROM files f WHERE f.portable_path = i.portable AND f.path = i.path)
        ELSE EXISTS (SELECT 1 FROM files f WHERE f.portable_path = i.portable AND f.path = i.path AND f.storage_key = i.storage_key) END) `;
	const statement = (sql: string, ...args: unknown[]) => db.prepare(committed + sql).bind(json, policy.folder_path, ...args);
	const removes = rows.some(row => !row.keep), keeps = rows.filter(row => row.keep), plain = keeps.filter(row => !row.stale);
	const removed = `portable_path IN (SELECT portable FROM committed WHERE keep = 0 AND storage_key IS NOT NULL)
        OR (portable_path, path) IN (SELECT portable, path FROM committed WHERE storage_key IS NULL)`;
	// A note's terms are keyed by its saved date, so they change only when a note leaves or its
	// terms or saved date differ; a status edit keeps them. The row's own term list names every
	// key to delete, so no second index on the terms is needed.
	const termKeys = (rows: string) => `(term, saved_at, portable_path) IN (SELECT t.value, r.saved_at, r.portable_path FROM (${rows}) r, json_each(r.terms) t)`;
	return [
		...(removes ? [statement(`DELETE FROM note_terms WHERE ${termKeys(`SELECT terms, saved_at, portable_path FROM reading_items WHERE ${removed}`)}`)] : []),
		// A changed saved date moves every key; otherwise only the terms the note lost leave,
		// and the insert below adds only the new ones.
		...(plain.length ? [statement(`DELETE FROM note_terms WHERE (term, saved_at, portable_path) IN (
        SELECT t.value, i.saved_at, i.portable_path FROM committed c JOIN reading_items i ON i.portable_path = c.portable, json_each(i.terms) t
        WHERE c.keep = 1 AND c.stale = 0 AND (i.terms, i.saved_at) IS NOT (c.terms, c.saved_at)
          AND (i.saved_at IS NOT c.saved_at OR c.terms IS NULL OR t.value NOT IN (SELECT value FROM json_each(c.terms))))`)] : []),
		...(plain.some(row => row.terms) ? [statement(`INSERT OR IGNORE INTO note_terms(term, saved_at, portable_path)
        SELECT t.value, r.saved_at, r.portable FROM (SELECT c.terms, c.saved_at, c.portable FROM committed c LEFT JOIN reading_items i ON i.portable_path = c.portable
          WHERE c.keep = 1 AND c.stale = 0 AND c.terms IS NOT NULL AND (i.terms, i.saved_at) IS NOT (c.terms, c.saved_at)) r, json_each(r.terms) t`)] : []),
		...(removes ? [
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
		// number, not every index. Each update also sets the unindexed columns, so the upsert
		// skips a row an update already brought to its new revision.
		...(plain.length ? [statement(`UPDATE reading_items SET path = c.path, item_id = c.item_id, saved_at = c.saved_at,
        article_hash = c.article_hash, article_edited = c.article_edited, stale = 0, ${UNINDEXED}
        FROM committed c WHERE c.keep = 1 AND c.stale = 0 AND reading_items.portable_path = c.portable
        AND (reading_items.path, reading_items.item_id, reading_items.saved_at, reading_items.article_hash, reading_items.article_edited, reading_items.stale)
          IS NOT (c.path, c.item_id, c.saved_at, c.article_hash, c.article_edited, 0)`),
			// Each section column has its own index, so each changes only where it differs.
			...(['status', 'favorite', 'highlighted'] as const).map(column => statement(`UPDATE reading_items SET ${column} = c.${column}, ${UNINDEXED}
        FROM committed c WHERE c.keep = 1 AND c.stale = 0 AND reading_items.portable_path = c.portable AND reading_items.${column} IS NOT c.${column}`)),
		] : []),
		// An encrypted note keeps its last card, list fields and terms until a device posts new ones.
		...(keeps.length > plain.length ? [statement(`UPDATE reading_items SET path = c.path, stale = 1
        FROM committed c WHERE c.keep = 1 AND c.stale = 1 AND reading_items.portable_path = c.portable AND (reading_items.path, reading_items.stale) IS NOT (c.path, 1)`)] : []),
		...(keeps.length ? [
			statement(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, metadata_json, error, article_hash, article_edited, saved_at,
          status, favorite, highlighted, stale, terms, words, card)
        SELECT portable, path, storage_key, hash, size, item_id, metadata_json, error, article_hash, article_edited, saved_at,
          status, favorite, highlighted, stale, terms, words, card FROM committed WHERE keep = 1
        ON CONFLICT(portable_path) DO UPDATE SET storage_key = excluded.storage_key, hash = excluded.hash, size = excluded.size,
          metadata_json = excluded.metadata_json, error = excluded.error, words = excluded.words,
          terms = CASE WHEN excluded.stale = 1 THEN reading_items.terms ELSE excluded.terms END,
          card = CASE WHEN excluded.stale = 1 THEN reading_items.card ELSE excluded.card END
        WHERE reading_items.storage_key IS NOT excluded.storage_key OR excluded.stale = 1`),
		] : []),

		// Recount the IDs this batch wrote and every flagged row: a row that changed or left
		// can only end a duplicate, and flagged rows are rare. Each branch uses an index;
		// an OR would scan the table.
		// Only rows whose flag flips change; a flip also changes the listing of an unchanged note.
		db.prepare(`UPDATE reading_items SET duplicate = 1 - duplicate
      WHERE portable_path IN (SELECT portable_path FROM reading_items WHERE item_id IN (SELECT value FROM json_each(?))
        UNION ALL SELECT portable_path FROM reading_items WHERE duplicate = 1)
        AND duplicate != ((SELECT count(*) FROM reading_items d WHERE d.item_id = reading_items.item_id) > 1)`).bind(JSON.stringify(keeps.flatMap(row => row.item_id ? [row.item_id] : []))),
	];
}

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
export type ReadingIndexState = { state: 'complete' | 'pending' | 'unavailable'; rebuilt?: boolean };

export interface ReadingIndexRow { scope: string; cursor: string | null }
export const readingIndexStatement = (db: D1Database) => db.prepare('SELECT scope, cursor FROM reading_index WHERE id = 1');

/** The state of an index row that is complete for `current`, or null when it must be (re)built. */
export function completeReadingIndex(current: ReadingPolicy, index: ReadingIndexRow | null): ReadingIndexState | null {
	return index?.scope === readingIndexScope(current) && index.cursor === null
		? { state: 'complete' } : null;
}

/** The index state for `current`. While the index is being rebuilt, each call indexes
 * the next files from R2; a failed read keeps the position and reports `unavailable`.
 * `loaded` is the index row when the caller already read it in a batch.
 * In an encrypted vault each note's card is read from the public data stored with it. */
export async function ensureReadingIndex(env: Env, current: ReadingPolicy, readBytes: (file: StoredReadingFile) => Promise<ArrayBuffer>, loaded?: ReadingIndexRow | null, encrypted = false): Promise<ReadingIndexState> {
	const db = env.DB, scope = readingIndexScope(current);
	let index = loaded !== undefined ? loaded : await readingIndexStatement(db).first<ReadingIndexRow>();
	const complete = completeReadingIndex(current, index);
	if (complete) return complete;
	if (index?.scope !== scope) {
		index = { scope, cursor: '' };
		await db.batch([
			db.prepare('DELETE FROM reading_items'),
			db.prepare('DELETE FROM note_terms'),
			db.prepare('DELETE FROM reading_jobs WHERE generation != ?').bind(current.generation),
			db.prepare(`INSERT INTO reading_index(id, scope, cursor) VALUES (1, ?, '')
        ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, cursor = excluded.cursor`).bind(scope),
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
			// An encrypted note is read for the card its upload carried.
			if (file.size <= (encrypted ? MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES : MAX_READING_BYTES)) {
				try { change.content = await readBytes({ path: file.path, storageKey: file.storage_key, hash: file.hash, size: file.size }); }
				catch { unavailable = true; break; }
			}
			changes.push(change);
		}
		cursor = file.portable_path;
	}
	const next = !unavailable && results.length < REBUILD_PAGE ? null : cursor;
	await db.batch([
		...await readingIndexStatements(db, changes, { policy: current, encrypted }),
		db.prepare('UPDATE reading_index SET cursor = ? WHERE id = 1 AND scope = ?').bind(next, scope),
	]);
	return { state: unavailable ? 'unavailable' : next === null ? 'complete' : 'pending', rebuilt: true };
}
