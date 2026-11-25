import { managedArticle } from '@/reading/core/article';
import { parseReadingNote } from '@/reading/core/notes';
import { MAX_READING_BYTES } from '@/reading/core/model';
import { highlightedAt, highlightSearchWords, highlightTerms, readingTerms, searchWords } from '@/reading/core/search-terms';
import { isReadingCardKind, validateReadingCardData, type ReadingCardData } from '@/reading/core/reading-card';
import { hasCurrentEncryptedFilePrefix, parseEncryptedFile } from '@/encryption/file-format';
import { MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES } from '@/encryption/file-inventory';
import { portablePathKey } from '@/protocol/portable-path';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { sha256Hex } from '@/platform/sha256';
import { fileFolderArgs } from '../sync/file-identity';
import type { Env } from '../types';
import { isMarkdownNoteInFolder, isMarkdownPath } from '../../../protocol/note-paths';

/** `reading_items` holds one row per Reading note in the Reading folder, written in the
 * same D1 batch as the file commit, so reads never re-check `files`. Only a new scope
 * (folder, generation or format), a restore or an initial import rebuilds it from R2. */
const INDEX_FORMAT = 1;
/** The upsert's unindexed columns for a note with a current card or metadata, from `committed c`. */
const UNINDEXED = `storage_key = c.storage_key, hash = c.hash, size = c.size, metadata_json = c.metadata_json,
        error = c.error, words = c.words, terms = c.terms, tag_terms = c.tag_terms, card = c.card, highlighted_at = c.highlighted_at`;
/** The sections a row's tags are counted in, as their lists select them. */
const SECTION_ROWS = "sections(section) AS (VALUES ('inbox'), ('archived'), ('favorites'), ('highlights'))";
const LISTED_IN = (row: string) => `CASE s.section WHEN 'inbox' THEN ${row}.status = 'inbox' WHEN 'archived' THEN ${row}.status = 'archived'
        WHEN 'favorites' THEN ${row}.favorite = 1 ELSE ${row}.highlighted_at IS NOT NULL AND ${row}.status IS NOT NULL END`;
/** Listed in the web app: an unencrypted note without a duplicate ID, or an encrypted note with a card. */
const VISIBLE = (row: string, duplicate = `${row}.duplicate`) => `((${row}.metadata_json IS NOT NULL AND ${duplicate} = 0) OR ${row}.card IS NOT NULL)`;
/** Adds each row's `n` to the count of every section and tag it is listed under. `rows` selects
 * `tag_terms`, `status`, `favorite`, `highlighted_at`, `visible` and `n`. Only counts that change
 * are written; CROSS JOIN keeps `rows` outermost, so it is read once, not once per section.
 * Follows a WITH list, or starts one with `WITH`. */
const countChange = (rows: string) => `${SECTION_ROWS}, changed AS (${rows})
      INSERT INTO reading_tag_counts(section, term, count) SELECT s.section, t.value, sum(x.n) FROM changed x CROSS JOIN json_each(x.tag_terms) t CROSS JOIN sections s
      WHERE x.visible AND ${LISTED_IN('x')} GROUP BY s.section, t.value HAVING sum(x.n) != 0
      ON CONFLICT(section, term) DO UPDATE SET count = reading_tag_counts.count + excluded.count`;
const REBUILD_PAGE = 25;
/** Bytes one rebuild step reads, so up to 25 notes of up to 4 MB stay within Worker memory. */
const REBUILD_BYTES = 16 * 1024 * 1024;
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
	status?: string | null; favorite?: 0 | 1; terms?: string | null;
	/** An unencrypted note's title words, which confirm a search's candidates. */
	words?: string | null;
	/** An encrypted note's card from its public data, as JSON `{ card }`. */
	card?: string | null;
	/** An encrypted note whose upload carried no card: the row keeps its last one. */
	stale?: 0 | 1;
	/** A highlighted note's key in `highlight_index`, with the JSON terms and, unencrypted, the
	 * words a highlight search matches. */
	highlighted_at?: string | null; highlight_terms?: string | null; highlight_words?: string | null;
	/** An encrypted note's sealed tag names, as JSON. */
	tag_names?: string | null;
	/** The note's tag terms, as JSON: counted per section in `reading_tag_counts`. */
	tag_terms?: string | null;
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

function isEncryptedContent(content: string | ArrayBuffer | null | undefined): boolean {
	if (content == null) return false;
	return hasCurrentEncryptedFilePrefix(typeof content === 'string' ? content : new Uint8Array(content));
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
		const highlights = { highlighted_at: data.highlighted_at, highlight_terms: JSON.stringify(data.highlight_terms), tag_names: JSON.stringify(data.tag_names) };
		return { ...row, item_id: fields.item_id, saved_at: fields.saved_at, status: fields.status, favorite: fields.favorite ? 1 : 0,
			terms: JSON.stringify(data.terms), tag_terms: JSON.stringify(data.tag_names.map(tag => tag.term)), card: JSON.stringify({ card: data.card }), ...highlights };
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
	const terms = readingTerms(metadata);
	return { ...row, item_id: metadata.crate_reading_id, url: metadata.source_url || null,
		metadata_json: JSON.stringify(metadata), article_hash, article_edited, saved_at: metadata.saved_at,
		status: metadata.reading_status, favorite: metadata.favorite ? 1 : 0,
		terms: JSON.stringify(terms), tag_terms: JSON.stringify(terms.filter(term => term.startsWith('t:'))), words: JSON.stringify(searchWords(metadata.title)),
		highlighted_at: highlightedAt(metadata), highlight_terms: JSON.stringify(highlightTerms(metadata)), highlight_words: JSON.stringify(highlightSearchWords(metadata)) };
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
		if (row === 'unknown') return [db.prepare('UPDATE reading_policy SET index_scope = NULL, index_cursor = NULL WHERE id = 1')];
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
      COALESCE(json_extract(value, '$.favorite'), 0) AS favorite,
      json_extract(value, '$.terms') AS terms, json_extract(value, '$.words') AS words, json_extract(value, '$.card') AS card,
      COALESCE(json_extract(value, '$.stale'), 0) AS stale, json_extract(value, '$.highlighted_at') AS highlighted_at,
      json_extract(value, '$.highlight_terms') AS highlight_terms, json_extract(value, '$.highlight_words') AS highlight_words,
      json_extract(value, '$.tag_names') AS tag_names, json_extract(value, '$.tag_terms') AS tag_terms FROM json_each(?1)),
    committed AS (SELECT i.* FROM input i WHERE EXISTS (SELECT 1 FROM reading_policy WHERE id = 1 AND folder_path = ?2)
      AND CASE WHEN i.storage_key IS NULL THEN NOT EXISTS (SELECT 1 FROM files f WHERE f.portable_path = i.portable AND f.path = i.path)
        ELSE EXISTS (SELECT 1 FROM files f WHERE f.portable_path = i.portable AND f.path = i.path AND f.storage_key = i.storage_key) END) `;
	const statement = (sql: string, ...args: unknown[]) => db.prepare(committed + sql).bind(json, policy.folder_path, ...args);
	const removes = rows.some(row => !row.keep), keeps = rows.filter(row => row.keep), plain = keeps.filter(row => !row.stale);
	// A path this batch also keeps is an update of that row, not a removal.
	const removed = `(portable_path IN (SELECT portable FROM committed WHERE keep = 0 AND storage_key IS NOT NULL)
        OR (portable_path, path) IN (SELECT portable, path FROM committed WHERE storage_key IS NULL))
        AND portable_path NOT IN (SELECT portable FROM committed WHERE keep = 1)`;
	// Derived rows name a note by its row id, so a note keeps them while it moves.
	const termKeys = (rows: string) => `(term, saved_at, item) IN (SELECT t.value, r.saved_at, r.id FROM (${rows}) r, json_each(r.terms) t)`;
	// The rows whose terms this batch may remove, read before `reading_items` changes.
	const lostTerms = (rows: string) => `SELECT t.value FROM (${rows}) r, json_each(r.terms) t`;
	// A row this batch writes or removes, by its current state; `removed` names the row the
	// innermost query reads.
	const touched = `(portable_path IN (SELECT portable FROM committed WHERE keep = 1 AND stale = 0) OR (${removed}))`;
	// Reading IDs rows leave in this batch, read before the rows change: only their groups can
	// shrink, so only their duplicates can end. Each group is counted as it will be after the
	// batch: its rows the batch leaves alone, and the batch's notes that will carry the ID.
	const left = [
		...removes ? [`SELECT item_id FROM reading_items WHERE item_id IS NOT NULL AND (${removed})`] : [],
		`SELECT i.item_id FROM committed c JOIN reading_items i ON i.portable_path = c.portable
          WHERE c.keep = 1 AND c.stale = 0 AND i.item_id IS NOT NULL AND i.item_id IS NOT c.item_id`,
	].join(' UNION ALL ');
	const ended = `duplicate = 1 AND item_id IN (${left}) AND NOT ${touched}
        AND (SELECT count(*) FROM reading_items d WHERE d.item_id = reading_items.item_id AND NOT ${touched})
          + (SELECT count(*) FROM committed c WHERE c.keep = 1 AND c.stale = 0 AND c.item_id = reading_items.item_id) = 1`;
	return [
		// Duplicates whose other copies this batch moves to another ID or removes end here, with
		// their notes listed again; the recount at the end handles the IDs the batch writes.
		...(removes || plain.length ? [
			statement(`, ${countChange(`SELECT tag_terms, status, favorite, highlighted_at, 1 AS visible, 1 AS n
        FROM reading_items WHERE ${ended} AND metadata_json IS NOT NULL AND card IS NULL`)}`),
			statement(`UPDATE reading_items SET duplicate = 0 WHERE ${ended}`),
		] : []),
		// A move removes its source and keeps its destination in one batch. The note's row moves
		// to the new path with its terms, highlight row and counts; the statements below then
		// change only what else differs.
		...(removes && keeps.some(row => row.item_id) ? [statement(`UPDATE reading_items SET path = c.path, portable_path = c.portable
        FROM committed c, committed r WHERE c.keep = 1 AND c.item_id IS NOT NULL AND r.storage_key IS NULL
          AND reading_items.portable_path = r.portable AND reading_items.path = r.path AND reading_items.item_id = c.item_id
          AND NOT EXISTS (SELECT 1 FROM reading_items x WHERE x.portable_path = c.portable)`)] : []),
		...(removes ? [
			statement(`DELETE FROM note_terms WHERE ${termKeys(`SELECT id, terms, saved_at FROM reading_items WHERE ${removed}`)}`),
			// One subquery per statement: a row-value IN over a compound select scans the whole table.
			statement(`DELETE FROM highlight_index WHERE (highlighted_at, item) IN (
        SELECT highlighted_at, id FROM reading_items WHERE highlighted_at IS NOT NULL AND (${removed}))`),
		] : []),
		// A new note's row is added with its list fields and without terms, so the statements
		// below add its terms and highlight row the way they change an existing note's, and the
		// upsert then fills its revision and the rest.
		...(keeps.length ? [statement(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, saved_at,
          status, favorite, article_hash, article_edited, stale)
        SELECT portable, path, '', hash, size, item_id, saved_at, status, favorite, article_hash, article_edited, stale FROM committed c
        WHERE keep = 1 AND NOT EXISTS (SELECT 1 FROM reading_items x WHERE x.portable_path = c.portable)`)] : []),
		// Tag counts change by each note's old listing taken away and its new one added; a note
		// that keeps its tags and sections writes none. A new note's row above lists nothing yet,
		// and a duplicate ID found below adjusts its counts there.
		// Each written note is read once and listed twice: its row as it was (-1) and as it will be (1).
		...(plain.length || removes ? [statement(`, ${countChange(`
        SELECT CASE k.n WHEN 1 THEN c.tag_terms ELSE i.tag_terms END AS tag_terms, CASE k.n WHEN 1 THEN c.status ELSE i.status END AS status,
          CASE k.n WHEN 1 THEN c.favorite ELSE i.favorite END AS favorite, CASE k.n WHEN 1 THEN c.highlighted_at ELSE i.highlighted_at END AS highlighted_at,
          CASE k.n WHEN 1 THEN ${VISIBLE('c', 'i.duplicate')} ELSE ${VISIBLE('i')} END AS visible, k.n AS n
        FROM committed c CROSS JOIN reading_items i ON i.portable_path = c.portable CROSS JOIN (SELECT -1 AS n UNION ALL SELECT 1) k
        WHERE c.keep = 1 AND c.stale = 0${removes ? `
        UNION ALL SELECT tag_terms, status, favorite, highlighted_at, ${VISIBLE('reading_items')}, -1 FROM reading_items WHERE ${removed}` : ''}`)}`)] : []),
		// A note's terms are keyed by its saved date, so they change only when its terms or saved
		// date differ; a status edit keeps them. The row's own term list names every key to
		// delete, so no second index on the terms is needed. A changed saved date moves every key;
		// otherwise only the terms the note lost leave, and only new ones are added.
		...(plain.length ? [statement(`DELETE FROM note_terms WHERE (term, saved_at, item) IN (
        SELECT t.value, i.saved_at, i.id FROM committed c JOIN reading_items i ON i.portable_path = c.portable, json_each(i.terms) t
        WHERE c.keep = 1 AND c.stale = 0 AND (i.terms, i.saved_at) IS NOT (c.terms, c.saved_at)
          AND (i.saved_at IS NOT c.saved_at OR c.terms IS NULL OR t.value NOT IN (SELECT value FROM json_each(c.terms))))`)] : []),
		...(plain.some(row => row.terms) ? [statement(`INSERT OR IGNORE INTO note_terms(term, saved_at, item)
        SELECT t.value, c.saved_at, i.id FROM committed c JOIN reading_items i ON i.portable_path = c.portable, json_each(c.terms) t
        WHERE c.keep = 1 AND c.stale = 0 AND c.terms IS NOT NULL AND (i.terms, i.saved_at) IS NOT (c.terms, c.saved_at)`)] : []),
		// An encrypted vault lists a tag's name while any note has its term. A name leaves only
		// once its term left note_terms above; a note that keeps or gains the tag adds it back.
		// Only encrypted notes carry tag names, so an unencrypted edit skips this read.
		...(removes || plain.some(row => row.card) ? [statement(`DELETE FROM reading_tags WHERE term IN (
        ${lostTerms(`SELECT terms FROM reading_items WHERE ${removed}`)}
        UNION ALL ${lostTerms('SELECT i.terms FROM committed c JOIN reading_items i ON i.portable_path = c.portable WHERE c.keep = 1 AND c.stale = 0 AND i.terms IS NOT c.terms')})
        AND NOT EXISTS (SELECT 1 FROM note_terms n WHERE n.term = reading_tags.term)`)] : []),
		...(plain.some(row => row.tag_names) ? [statement(`INSERT OR IGNORE INTO reading_tags(term, name)
        SELECT json_extract(t.value, '$.term'), json_extract(t.value, '$.name') FROM committed c, json_each(c.tag_names) t
        WHERE c.keep = 1 AND c.stale = 0 AND c.tag_names IS NOT NULL`)] : []),
		// A note's highlight row is keyed by when it was last highlighted, so a new highlight
		// moves it; other highlight edits update its terms in place.
		...(plain.length ? [statement(`DELETE FROM highlight_index WHERE (highlighted_at, item) IN (
        SELECT i.highlighted_at, i.id FROM committed c JOIN reading_items i ON i.portable_path = c.portable
          WHERE c.keep = 1 AND c.stale = 0 AND i.highlighted_at IS NOT NULL AND i.highlighted_at IS NOT c.highlighted_at)`)] : []),
		...(plain.some(row => row.highlighted_at) ? [statement(`INSERT INTO highlight_index(highlighted_at, item, terms, words)
        SELECT c.highlighted_at, i.id, c.highlight_terms, c.highlight_words FROM committed c JOIN reading_items i ON i.portable_path = c.portable
        WHERE c.keep = 1 AND c.stale = 0 AND c.highlighted_at IS NOT NULL
        ON CONFLICT(highlighted_at, item) DO UPDATE SET terms = excluded.terms, words = excluded.words
        WHERE (highlight_index.terms, highlight_index.words) IS NOT (excluded.terms, excluded.words)`)] : []),
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
		// only unindexed columns. A favorite rewrites the row and one section index, not every
		// index. Each update also sets the unindexed columns, so the upsert skips a row an update
		// already brought to its new revision.
		...(plain.length ? [statement(`UPDATE reading_items SET path = c.path, item_id = c.item_id, saved_at = c.saved_at,
        article_hash = c.article_hash, article_edited = c.article_edited, stale = 0, ${UNINDEXED}
        FROM committed c WHERE c.keep = 1 AND c.stale = 0 AND reading_items.portable_path = c.portable
        AND (reading_items.path, reading_items.item_id, reading_items.saved_at, reading_items.article_hash, reading_items.article_edited, reading_items.stale)
          IS NOT (c.path, c.item_id, c.saved_at, c.article_hash, c.article_edited, 0)`),
			// Each section column has its own index, so each changes only where it differs.
			...(['status', 'favorite'] as const).map(column => statement(`UPDATE reading_items SET ${column} = c.${column}, ${UNINDEXED}
        FROM committed c WHERE c.keep = 1 AND c.stale = 0 AND reading_items.portable_path = c.portable AND reading_items.${column} IS NOT c.${column}`)),
		] : []),
		// An encrypted note keeps its last card, list fields and terms until a device posts new ones.
		...(keeps.length > plain.length ? [statement(`UPDATE reading_items SET path = c.path, stale = 1
        FROM committed c WHERE c.keep = 1 AND c.stale = 1 AND reading_items.portable_path = c.portable AND (reading_items.path, reading_items.stale) IS NOT (c.path, 1)`)] : []),
		...(keeps.length ? [
			// Every kept note has a row by now, so this only updates: an upsert reads fewer rows than an
			// update from a join.
			statement(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, metadata_json, error, words, terms, tag_terms, card, highlighted_at, stale)
        SELECT portable, path, storage_key, hash, size, metadata_json, error, words, terms, tag_terms, card, highlighted_at, stale FROM committed WHERE keep = 1
        ON CONFLICT(portable_path) DO UPDATE SET storage_key = excluded.storage_key, hash = excluded.hash, size = excluded.size,
          metadata_json = excluded.metadata_json, error = excluded.error, words = excluded.words,
          terms = CASE WHEN excluded.stale = 1 THEN reading_items.terms ELSE excluded.terms END,
          tag_terms = CASE WHEN excluded.stale = 1 THEN reading_items.tag_terms ELSE excluded.tag_terms END,
          card = CASE WHEN excluded.stale = 1 THEN reading_items.card ELSE excluded.card END,
          highlighted_at = CASE WHEN excluded.stale = 1 THEN reading_items.highlighted_at ELSE excluded.highlighted_at END
        WHERE reading_items.storage_key IS NOT excluded.storage_key OR excluded.stale = 1`),
		] : []),

		...duplicateRecount(db, keeps.flatMap(row => row.item_id ? [row.item_id] : [])),
		// The library revision names this commit's changelog entry, so clients ask what changed
		// since. A commit without one, such as an initial import or a rebuild step, starts a new
		// epoch, so clients read their first page again.
		db.prepare(`UPDATE reading_policy SET epoch = epoch + ((SELECT max(seq) FROM changelog) IS changed),
        changed = COALESCE((SELECT max(seq) FROM changelog), changed) WHERE id = 1`),
	];
}

/** Recounts the notes with the IDs `itemIds`: ones a batch wrote, or ones rows it removed
 * carried. An ID a written row left is recounted before the batch changes it. Only rows whose
 * flag flips change; a flip also changes the listing of an unchanged note. */
function duplicateRecount(db: D1Database, itemIds: string[]): D1PreparedStatement[] {
	const flips = `item_id IN (SELECT value FROM json_each(?1))
        AND duplicate != ((SELECT count(*) FROM reading_items d WHERE d.item_id = reading_items.item_id) > 1)`, ids = JSON.stringify(itemIds);
	return [
		// Only an unencrypted note's listing depends on the flag: it leaves its counts as it becomes a duplicate.
		db.prepare(`WITH ${countChange(`SELECT tag_terms, status, favorite, highlighted_at, 1 AS visible, CASE WHEN duplicate = 0 THEN -1 ELSE 1 END AS n
        FROM reading_items WHERE ${flips} AND metadata_json IS NOT NULL AND card IS NULL`)}`).bind(ids),
		db.prepare(`UPDATE reading_items SET duplicate = 1 - duplicate WHERE ${flips}`).bind(ids),
	];
}

/** Removes the rows `ids` and everything derived from them, for a rebuild that found their
 * file gone, outside the folder, or in an older index format. */
function removedRowStatements(db: D1Database, rows: Array<{ id: number; item_id: string | null }>): D1PreparedStatement[] {
	if (!rows.length) return [];
	const ids = JSON.stringify(rows.map(row => row.id)), removed = 'SELECT * FROM reading_items WHERE id IN (SELECT value FROM json_each(?1))';
	return [
		db.prepare(`WITH ${countChange(`SELECT tag_terms, status, favorite, highlighted_at, ${VISIBLE('r')} AS visible, -1 AS n FROM (${removed}) r`)}`).bind(ids),
		db.prepare(`DELETE FROM note_terms WHERE (term, saved_at, item) IN (SELECT t.value, r.saved_at, r.id FROM (${removed}) r, json_each(r.terms) t)`).bind(ids),
		db.prepare(`DELETE FROM highlight_index WHERE (highlighted_at, item) IN (SELECT highlighted_at, id FROM (${removed}) WHERE highlighted_at IS NOT NULL)`).bind(ids),
		db.prepare(`DELETE FROM reading_tags WHERE term IN (SELECT t.value FROM (${removed}) r, json_each(r.terms) t)
      AND NOT EXISTS (SELECT 1 FROM note_terms n WHERE n.term = reading_tags.term)`).bind(ids),
		db.prepare(`DELETE FROM reading_jobs WHERE path IN (SELECT path FROM (${removed}))`).bind(ids),
		db.prepare('DELETE FROM reading_items WHERE id IN (SELECT value FROM json_each(?1))').bind(ids),
		...duplicateRecount(db, rows.flatMap(row => row.item_id ? [row.item_id] : [])),
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
/** `rebuilt` marks a call that indexed files, which can queue article extraction. `waiting`
 * means the day's rebuild writes are spent; the next step runs at `retryAt`. */
export type ReadingIndexState = { state: 'complete' | 'pending' | 'unavailable'; rebuilt?: boolean } | { state: 'waiting'; retryAt: number; rebuilt?: undefined };

/** `day` and `rows` count the rows rebuild steps wrote on one UTC day; `changed` and `epoch`
 * make the library revision (`readingRevision`). */
export interface ReadingIndexRow { scope: string | null; cursor: string | null; day?: number | null; rows?: number | null; changed?: number; epoch?: number }
export const readingIndexStatement = (db: D1Database) => db.prepare(`SELECT index_scope AS scope, index_cursor AS cursor, index_day AS day, index_rows AS rows,
    changed, epoch FROM reading_policy WHERE id = 1`);
/** The library revision clients compare and ask changes since: `<epoch>.<changed>`. */
export const readingRevision = (index: Pick<ReadingIndexRow, 'changed' | 'epoch'> | null) => `${index?.epoch ?? 0}.${index?.changed ?? 0}`;

/** The state of an index row that is complete for `current`, or null when it must be (re)built. */
export function completeReadingIndex(current: ReadingPolicy, index: ReadingIndexRow | null): ReadingIndexState | null {
	return index?.scope === readingIndexScope(current) && index.cursor === null
		? { state: 'complete' } : null;
}

/** Rows each rebuild step checks; unchanged rows cost a read and no write. */
const RECONCILE_PAGE = 500;
/** Rows rebuild steps may write in one UTC day, so a large first import or a new folder leaves
 * the free plan's 100,000 daily writes room for sync. */
export const READING_REBUILD_DAILY_ROWS = 50_000;
const DAY_MS = 86_400_000;
const formatOf = (scope: string | null | undefined) => scope?.split('\n')[2];

/** The index state for `current`. While the index is incomplete, each call takes one step,
 * starting from `cursor`:
 * - `wipe:<id>` (a new index format) removes every row, then the files are indexed again;
 * - `rows:<id>` removes rows whose file is gone or outside the folder;
 * - `files:<path>` indexes each file in the folder whose row does not name its current
 *   revision, reading only those notes from R2.
 * A restore, a new folder or a commit whose bytes the writer could not see keeps every row
 * that still names its file, so an unchanged library is checked without writes. A failed read
 * keeps the position and reports `unavailable`. `loaded` is the index row when the caller
 * already read it in a batch. In an encrypted vault each note's card is read from the public
 * data stored with it. */
export async function ensureReadingIndex(env: Env, current: ReadingPolicy, readBytes: (file: StoredReadingFile) => Promise<ArrayBuffer>, loaded?: ReadingIndexRow | null, encrypted = false, now = Date.now()): Promise<ReadingIndexState> {
	const db = env.DB, scope = readingIndexScope(current);
	const index = loaded !== undefined ? loaded : await readingIndexStatement(db).first<ReadingIndexRow>();
	const complete = completeReadingIndex(current, index);
	if (complete) return complete;
	const today = Math.floor(now / DAY_MS);
	if (index?.day === today && (index.rows ?? 0) >= READING_REBUILD_DAILY_ROWS) return { state: 'waiting', retryAt: (today + 1) * DAY_MS };
	const position = index?.scope === scope && index.cursor ? index.cursor
		: formatOf(index?.scope) === formatOf(scope) || !index?.scope ? 'rows:0' : 'wipe:0';
	const split = position.indexOf(':'), phase = position.slice(0, split);
	let after = position.slice(split + 1), next: string | null, state: 'complete' | 'pending' | 'unavailable' = 'pending';
	const statements: D1PreparedStatement[] = [];
	if (phase === 'wipe' || phase === 'rows') {
		const { results } = await db.prepare(`SELECT i.id, i.item_id, i.path, f.storage_key AS file FROM reading_items i
      LEFT JOIN files f ON f.portable_path = i.portable_path AND f.path = i.path WHERE i.id > ? ORDER BY i.id LIMIT ${RECONCILE_PAGE}`)
			.bind(Number(after)).all<{ id: number; item_id: string | null; path: string; file: string | null }>();
		const gone = phase === 'wipe' ? results : results.filter(row => row.file === null || !isReadingNotePath(row.path, current.folder_path));
		statements.push(...removedRowStatements(db, gone));
		next = results.length < RECONCILE_PAGE ? 'files:' : `${phase}:${results.at(-1)!.id}`;
		after = '';
	} else next = position;
	// Once the rows are checked, the same step starts on the files, so a small library is rebuilt
	// in one call. After a wipe in the same step, every file is indexed again.
	const wiped = phase === 'wipe';
	if (next === 'files:' || phase === 'files') {
		// Only notes are indexed, so saved images and other files never take a step. LIKE matches
		// `.md` in any letter case, as `isReadingNotePath` does. The cursor is the walk's only lower
		// bound: beside the folder's own, SQLite seeks to the folder's start and reads every file
		// the earlier steps walked.
		const [folderStart, folderEnd, pathStart, pathEnd] = fileFolderArgs(current.folder_path);
		const { results } = await db.prepare(`SELECT f.path, f.portable_path, f.hash, f.size, f.storage_key, i.storage_key AS indexed, i.path AS indexed_path
      FROM (SELECT path, portable_path, hash, size, storage_key FROM files WHERE portable_path > ? AND portable_path < ? AND path >= ? AND path < ? AND path LIKE '%.md'
        ORDER BY portable_path LIMIT ${RECONCILE_PAGE}) f
      LEFT JOIN reading_items i ON i.portable_path = f.portable_path ORDER BY f.portable_path`).bind(after || folderStart, folderEnd, pathStart, pathEnd)
			.all<{ path: string; portable_path: string; hash: string; size: number; storage_key: string; indexed: string | null; indexed_path: string | null }>();
		const changes: ReadingFileChange[] = [];
		let cursor = after, unavailable = false, stopped = false, read = 0;
		for (const file of results) {
			if (isReadingNotePath(file.path, current.folder_path) && (wiped || file.indexed !== file.storage_key || file.indexed_path !== file.path)) {
				// The next step continues from here once this one's bytes are released.
				if (changes.length >= REBUILD_PAGE) { stopped = true; break; }
				const change: ReadingFileChange = { path: file.path, storageKey: file.storage_key, hash: file.hash, size: file.size };
				// An encrypted note is read for the card its upload carried.
				if (file.size <= (encrypted ? MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES : MAX_READING_BYTES)) {
					if (changes.length && read + file.size > REBUILD_BYTES) { stopped = true; break; }
					read += file.size;
					try { change.content = await readBytes({ path: file.path, storageKey: file.storage_key, hash: file.hash, size: file.size }); }
					catch { unavailable = true; break; }
				}
				changes.push(change);
			}
			cursor = file.portable_path;
		}
		statements.push(...await readingIndexStatements(db, changes, { policy: current, encrypted }));
		next = !unavailable && !stopped && results.length < RECONCILE_PAGE ? null : `files:${cursor}`;
		if (unavailable) state = 'unavailable';
	}
	if (next === null) state = 'complete';
	// A step that changed rows starts a new epoch: the changelog does not list its changes.
	const results = await db.batch([
		...statements,
		db.prepare('UPDATE reading_policy SET index_scope = ?, index_cursor = ?, epoch = epoch + ? WHERE id = 1').bind(scope, next, statements.length ? 1 : 0),
	]);
	const written = results.reduce((sum: number, result) => sum + ((result as { meta?: { rows_written?: number } }).meta?.rows_written ?? 0), 0);
	await db.prepare('UPDATE reading_policy SET index_rows = CASE WHEN index_day IS ? THEN index_rows + ? ELSE ? END, index_day = ? WHERE id = 1')
		.bind(today, written, written, today).run();
	return { state, rebuilt: true };
}
