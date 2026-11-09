import type { Env } from '../types';
import { ReadingError, readingItemId, readingNotModified, readingResponse, readSourceRow, sourceRowsStatement, uniqueSourceRow, type ReadingSourceRow } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { parseReadingNote } from '@/reading/core/notes';
import { READING_DUPLICATE_ID_ISSUE } from '@/reading/core/inventory';
import { readingUrlIdentity, validateReadingMetadata } from '@/reading/core/model';
import type { ReadingSection } from '@/reading/core/reading-presentation';
import { MAX_QUERY_WORDS, normalizedTag, searchWords } from '@/reading/core/search-terms';
import { isHashedReadingTerm } from '@/encryption/reading-search';
import { sha256Hex } from '@/platform/sha256';
import { ARTICLE_EDITED_ERROR, READING_TERM_SCOPE, readingIndexScope, readingIndexStatement, type ReadingIndexRow, type ReadingIndexState } from './library-index';

/** A queued capture with this ID and the index rows that name it, read together. */
export const readingItemStatements = (db: D1Database, id: string) => [
	db.prepare('SELECT note FROM reading_captures WHERE id = ? AND generation = (SELECT generation FROM reading_policy WHERE id = 1)').bind(id),
	sourceRowsStatement(db, id),
];
type Rows<T> = { results: T[] };
export type ReadingItemRows = [Rows<{ note: string }>, Rows<ReadingSourceRow>];

// Bump when the same note revision would produce a different item response.
const ITEM_FORMAT = 1;
/** An indexed item's response depends only on the note revision its row names. */
export async function readingItemEtag(current: ReadingPolicy, id: string, row: Pick<ReadingSourceRow, 'path' | 'storage_key' | 'hash'>): Promise<string> {
	return `"${(await sha256Hex(`item:${ITEM_FORMAT}\n${readingIndexScope(current)}\n${id}\n${row.path}\n${row.storage_key}\n${row.hash}`)).slice(0, 32)}"`;
}

/** Called only after route authorization and a complete Reading index. `loaded` holds
 * `readingItemStatements` results the caller already read. A matching indexed revision
 * answers 304 without reading R2; a queued capture has no revision and no ETag. */
export async function readingItem(env: Env, current: ReadingPolicy, id: unknown, ifNoneMatch: string | null, loaded?: ReadingItemRows): Promise<Response> {
	const itemId = readingItemId(id);
	const [queued, rows] = loaded ?? await env.DB.batch(readingItemStatements(env.DB, itemId)) as ReadingItemRows;
	const note = queued.results[0]?.note;
	if (note !== undefined) return readingResponse({ item: { ...parseReadingNote(note)!, path: '' }, markdown: '' });
	const row = uniqueSourceRow(rows.results);
	const etag = await readingItemEtag(current, itemId, row);
	if (etagMatches(ifNoneMatch, etag)) return readingNotModified(etag);
	const source = await readSourceRow(env, itemId, row);
	return readingResponse({ item: { ...source.item, path: source.path }, markdown: readReadingFrontmatter(source.content)?.body ?? '' }, 200, { ETag: etag });
}

/** The library changes only with its index revision, which every note and capture
 * queue change advances in its own transaction, and with the fetching setting. */
export async function readingListEtag(current: ReadingPolicy, revision: string): Promise<string> {
	return `"${(await sha256Hex(`${readingIndexScope(current)}\nenabled:${current.enabled}\nrevision:${revision}`)).slice(0, 32)}"`;
}

export const etagMatches = (header: string | null, etag: string) => header?.split(',').some(value => value.trim() === etag) ?? false;

// A changed library is reloaded page by page; larger pages keep that to a few
// requests for a 10,000-item library.
export const READING_LIST_PAGE = 1000;

interface ReadingRow { portable_path: string; path: string; metadata_json: string | null; error: string | null; article_edited: number; duplicate: number; saved_at: string }
const ROW_COLUMNS = 'portable_path, path, metadata_json, error, article_edited, duplicate, saved_at';
const queuedStatement = (env: Env, current: ReadingPolicy) =>
	env.DB.prepare('SELECT note FROM reading_captures WHERE generation=? ORDER BY available_at LIMIT 1000').bind(current.generation);

function listedPage(current: ReadingPolicy, rows: ReadingRow[], queued: Array<{ note: string }>) {
	const issue = (row: ReadingRow) => row.error
		?? (row.article_edited && current.enabled ? ARTICLE_EDITED_ERROR : null)
		?? (row.duplicate ? READING_DUPLICATE_ID_ISSUE : null);
	return { items: [...queued.map(row => ({ ...parseReadingNote(row.note)!, path: '' })), ...rows.filter(row => row.metadata_json && !row.duplicate).map(row => ({ ...validateReadingMetadata(JSON.parse(row.metadata_json!) as Record<string, unknown>), path: row.path }))],
		issues: rows.flatMap(row => { const message = issue(row); return message ? [{ path: row.path, message }] : []; }) };
}

/** The cursor is the last row's `(saved_at, portable_path)`, opaque to clients. */
function parseListCursor(cursor: string): [string, string] | null {
	if (!cursor) return null;
	let value: unknown;
	try { value = cursor.length <= 4096 ? JSON.parse(cursor) : null; } catch { value = null; }
	if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) throw new ReadingError('Invalid library cursor.');
	return value as [string, string];
}

/** Pages run newest first, so the first page of a first load is what the library shows on top. */
export async function readingList(env: Env, current: ReadingPolicy, cursor: string) {
	const after = parseListCursor(cursor);
	const page = env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM reading_items
    ${after ? 'WHERE (saved_at, portable_path) < (?, ?)' : ''} ORDER BY saved_at DESC, portable_path DESC LIMIT ${READING_LIST_PAGE}`)
		.bind(...after ?? []);
	// The first page and the capture queue come from one snapshot.
	const [{ results }, queuedRows] = await env.DB.batch(cursor ? [page] : [page, queuedStatement(env, current)]) as [Rows<ReadingRow>, Rows<{ note: string }>?];
	const queued = queuedRows?.results ?? [];
	const last = results.at(-1);
	return { ...listedPage(current, results, queued), cursor: results.length === READING_LIST_PAGE && last ? JSON.stringify([last.saved_at, last.portable_path]) : null };
}

/** The index position a client can later ask for changes since. A new index build or
 * fetching setting changes its suffix, so an older base relists everything. */
export async function readingDeltaBase(current: ReadingPolicy, index: Pick<ReadingIndexState, 'epoch' | 'seq'>): Promise<string> {
	return `${index.seq}.${(await sha256Hex(`reading\n${readingIndexScope(current)}\nenabled:${current.enabled}\nepoch:${index.epoch}`)).slice(0, 32)}`;
}

/** Rows changed and paths removed after change `since`, plus the whole capture queue.
 * Null when a full list is required: removals since then were pruned, the base is from
 * the future, or more notes changed than one page holds. */
export async function readingListDelta(env: Env, current: ReadingPolicy, index: Pick<ReadingIndexState, 'seq' | 'removedSeq'>, since: number) {
	if (since < index.removedSeq || since > index.seq) return null;
	// One snapshot: changed rows, removals, the capture queue and the pruned position cannot
	// disagree. Maintenance can prune removals after `index` was read, so this batch rechecks it.
	const [{ results: rows }, { results: removed }, { results: queued }, { results: [snapshot] }] = await env.DB.batch([
		env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM reading_items WHERE change_seq > ? ORDER BY change_seq LIMIT ${READING_LIST_PAGE + 1}`).bind(since),
		env.DB.prepare(`SELECT path FROM reading_removals WHERE change_seq > ? ORDER BY change_seq LIMIT ${READING_LIST_PAGE + 1}`).bind(since),
		queuedStatement(env, current),
		readingIndexStatement(env.DB),
	]) as [Rows<ReadingRow>, Rows<{ path: string }>, Rows<{ note: string }>, Rows<ReadingIndexRow>];
	if (!snapshot || since < snapshot.removedSeq || rows.length > READING_LIST_PAGE || removed.length > READING_LIST_PAGE) return null;
	const changedPaths = [...new Set([...removed.map(row => row.path), ...rows.map(row => row.path)])];
	return { delta: true as const, changedPaths, ...listedPage(current, rows, queued), cursor: null };
}

/** One page of the library view. Small, so a visit reads about one page of rows. */
const READING_ITEMS_PAGE = 50;
const MAX_READING_QUERY_TERMS = 10;
/** `all` lists every section, for a link or ID lookup. */
const SECTION_FILTERS: Record<ReadingSection | 'all', string> = {
	inbox: "status = 'inbox'", archived: "status = 'archived'", favorites: 'favorite = 1', highlights: 'highlighted = 1', all: 'status IS NOT NULL',
};
/** Above every code point, so `term < prefix + TERM_END` keeps every word that starts with `prefix`. */
const TERM_END = '\u{10FFFF}';

export interface ReadingItemsQuery {
	section: ReadingSection | 'all'; cursor: string;
	/** A Reading ID, to find one note. */
	id?: string;
	/** Unencrypted vaults: query words, a tag and a link. */
	q?: string; tag?: string; url?: string;
	/** Encrypted vaults: hashed terms; every one must match. */
	terms?: string[];
}

export function parseReadingItemsQuery(params: URLSearchParams, encrypted: boolean): ReadingItemsQuery {
	const section = params.get('section') ?? 'inbox';
	if (!(section in SECTION_FILTERS)) throw new ReadingError('Unknown Reading section.');
	const text = (name: string, max: number) => { const value = params.get(name) ?? ''; if (value.length > max) throw new ReadingError('Search is too long.'); return value || undefined; };
	const id = params.get('id');
	const common = { section: section as ReadingSection | 'all', cursor: params.get('cursor') ?? '', ...id !== null ? { id: readingItemId(id) } : {} };
	if (!encrypted) return { ...common, q: text('q', 500), tag: text('tag', 500), url: text('url', 8192) };
	const terms = params.getAll('term');
	if (terms.length > MAX_READING_QUERY_TERMS || !terms.every(isHashedReadingTerm)) throw new ReadingError('Invalid search terms.');
	return { ...common, terms };
}

interface ItemsRow extends ReadingRow { card: string | null; storage_key: string; stale: number; hash: string; size: number; item_id: string; status: string; favorite: number; highlighted: number }

/** Newest first. Each term narrows the page through `note_terms`, so a search reads the
 * notes it matches, not the library. The first unfiltered inbox page carries the capture queue
 * and the issues; an encrypted page carries each card for the device to open. */
export async function readingItems(env: Env, current: ReadingPolicy, encrypted: boolean, query: ReadingItemsQuery) {
	const after = parseListCursor(query.cursor), where = [SECTION_FILTERS[query.section]], args: unknown[] = [];
	where.push(encrypted ? 'card IS NOT NULL' : 'metadata_json IS NOT NULL AND duplicate = 0');
	if (after) { where.push('(saved_at, portable_path) < (?, ?)'); args.push(...after); }
	if (query.id) { where.push('item_id = ?'); args.push(query.id); }
	const words = encrypted ? [] : searchWords(query.q ?? '', MAX_QUERY_WORDS);
	for (const word of words) { where.push(`portable_path IN (SELECT portable_path FROM note_terms WHERE scope = '${READING_TERM_SCOPE}' AND term >= ? AND term < ?)`); args.push(`w:${word}`, `w:${word}${TERM_END}`); }
	const exact = encrypted ? query.terms ?? [] : query.tag ? [`t:${normalizedTag(query.tag)}`] : [];
	for (const term of exact) { where.push(`portable_path IN (SELECT portable_path FROM note_terms WHERE scope = '${READING_TERM_SCOPE}' AND term = ?)`); args.push(term); }
	if (!encrypted && query.url) {
		let identity: string; try { identity = readingUrlIdentity(query.url); } catch { throw new ReadingError('Enter a valid web link.'); }
		where.push('url_identity = ?'); args.push(identity);
	}
	const page = env.DB.prepare(`SELECT ${ROW_COLUMNS}, card, storage_key, stale, hash, size, item_id, status, favorite, highlighted FROM reading_items WHERE ${where.join(' AND ')}
    ORDER BY saved_at DESC, portable_path DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...args);
	const first = !after && query.section === 'inbox' && !words.length && !exact.length && !query.url && !query.id && !encrypted;
	const [{ results }, queuedRows, issueRows] = await env.DB.batch(first ? [page, queuedStatement(env, current),
		env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM reading_items WHERE error IS NOT NULL OR duplicate = 1 OR article_edited = 1 LIMIT 1000`)] : [page]) as [Rows<ItemsRow>, Rows<{ note: string }>?, Rows<ReadingRow>?];
	const last = results.at(-1);
	const cursor = results.length === READING_ITEMS_PAGE && last ? JSON.stringify([last.saved_at, last.portable_path]) : null;
	// The device checks the fields the page was sorted and filtered by against each card.
	const card = (row: ItemsRow) => ({ path: row.path, revision: row.storage_key, hash: row.hash, size: row.size, ...JSON.parse(row.card!) as { card: string; seal?: unknown }, stale: row.stale === 1,
		fields: { item_id: row.item_id, saved_at: row.saved_at, status: row.status, favorite: row.favorite === 1, highlighted: row.highlighted === 1 } });
	if (encrypted) {
		// Notes the server sealed have no terms, so a search cannot match them here. Every one in
		// this page's date range goes with it, for the device to match itself.
		const unindexed = exact.length ? await unindexedCards(env, query.section, after, cursor && last ? [last.saved_at, last.portable_path] : null) : [];
		return { cards: results.map(card), ...exact.length ? { unindexed: unindexed.map(card) } : {}, cursor };
	}
	const listed = listedPage(current, results, queuedRows?.results ?? []);
	return { items: listed.items, issues: issueRows ? listedPage(current, issueRows.results, []).issues : [], cursor };
}

// Sealed notes no device has saved again; a page's range rarely holds more.
const MAX_UNINDEXED = 1000;
/** Encrypted notes listed without search terms, newest first, from below `after` down to
 * `until` (inclusive), or to the oldest note on the last page. */
async function unindexedCards(env: Env, section: ReadingSection | 'all', after: [string, string] | null, until: [string, string] | null) {
	const where = [SECTION_FILTERS[section], "card IS NOT NULL AND terms = '[]'"], args: unknown[] = [];
	if (after) { where.push('(saved_at, portable_path) < (?, ?)'); args.push(...after); }
	if (until) { where.push('(saved_at, portable_path) >= (?, ?)'); args.push(...until); }
	const { results } = await env.DB.prepare(`SELECT ${ROW_COLUMNS}, card, storage_key, stale, hash, size, item_id, status, favorite, highlighted FROM reading_items
    WHERE ${where.join(' AND ')} ORDER BY saved_at DESC, portable_path DESC LIMIT ${MAX_UNINDEXED}`).bind(...args).all<ItemsRow>();
	return results;
}
