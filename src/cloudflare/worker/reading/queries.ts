import type { Env } from '../types';
import { ReadingError, readingItemId, readingNotModified, readingResponse, readSourceRow, sourceRowsStatement, uniqueSourceRow, type ReadingSourceRow } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { parseReadingNote } from '@/reading/core/notes';
import { READING_DUPLICATE_ID_ISSUE } from '@/reading/core/inventory';
import { readingUrlIdentity, validateReadingMetadata } from '@/reading/core/model';
import type { ReadingSection } from '@/reading/core/reading-presentation';
import { MAX_QUERY_WORDS, normalizedTag, searchWords, wordTerm } from '@/reading/core/search-terms';
import { isHashedReadingTerm } from '@/encryption/reading-search';
import { sha256Hex } from '@/platform/sha256';
import { ARTICLE_EDITED_ERROR, READING_TERM_SCOPE, readingIndexScope } from './library-index';

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

const etagMatches = (header: string | null, etag: string) => header?.split(',').some(value => value.trim() === etag) ?? false;

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

/** One page of the library view. Small, so a visit reads about one page of rows. */
const READING_ITEMS_PAGE = 50;
const MAX_READING_QUERY_TERMS = 10;
/** `all` lists every section, for a link or ID lookup. */
const SECTION_FILTERS: Record<ReadingSection | 'all', string> = {
	inbox: "status = 'inbox'", archived: "status = 'archived'", favorites: 'favorite = 1', highlights: 'highlighted = 1', all: 'status IS NOT NULL',
};
const ITEM_COLUMNS = `${ROW_COLUMNS}, card, storage_key, stale, hash, size, item_id, status, favorite, highlighted`;
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
	const after = parseListCursor(query.cursor);
	const visible = encrypted ? 'card IS NOT NULL' : 'metadata_json IS NOT NULL AND duplicate = 0';
	// A query word matches by its term (its first three letters); an unencrypted title then
	// confirms the whole word. An encrypted device sends its terms in the same order: link, tag,
	// longest word first.
	const words = encrypted ? [] : searchWords(query.q ?? '', MAX_QUERY_WORDS).sort((a, b) => [...b].length - [...a].length);
	let identity: string | undefined;
	if (!encrypted && query.url) { try { identity = readingUrlIdentity(query.url); } catch { throw new ReadingError('Enter a valid web link.'); } }
	const terms = encrypted ? query.terms ?? [] : [...identity ? [`u:${identity}`] : [], ...query.tag ? [`t:${normalizedTag(query.tag)}`] : [], ...words.map(wordTerm)];
	let page: D1PreparedStatement;
	if (terms.length) {
		// Each term lists its notes newest first, so the search walks the first term and stops
		// after a page; the other terms and words are checked on the row it reaches.
		const where = [`t.scope = '${READING_TERM_SCOPE}'`, 't.term = ?', ...[SECTION_FILTERS[query.section], visible].map(clause => clause.replace(/\b(status|favorite|highlighted|card|metadata_json|duplicate)\b/g, 'i.$1'))];
		const args: unknown[] = [terms[0]];
		if (after) { where.push('(t.saved_at, t.portable_path) < (?, ?)'); args.push(...after); }
		if (query.id) { where.push('i.item_id = ?'); args.push(query.id); }
		for (const term of new Set(terms.slice(1))) { where.push('EXISTS (SELECT 1 FROM json_each(i.terms) WHERE value = ?)'); args.push(term); }
		for (const word of words) { where.push('EXISTS (SELECT 1 FROM json_each(i.words) WHERE value >= ? AND value < ?)'); args.push(word, `${word}${TERM_END}`); }
		page = env.DB.prepare(`SELECT ${ITEM_COLUMNS.split(', ').map(column => `i.${column}`).join(', ')} FROM note_terms t JOIN reading_items i ON i.portable_path = t.portable_path
      WHERE ${where.join(' AND ')} ORDER BY t.saved_at DESC, t.portable_path DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...args);
	} else {
		const where = [SECTION_FILTERS[query.section], visible], args: unknown[] = [];
		if (after) { where.push('(saved_at, portable_path) < (?, ?)'); args.push(...after); }
		if (query.id) { where.push('item_id = ?'); args.push(query.id); }
		page = env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM reading_items WHERE ${where.join(' AND ')}
      ORDER BY saved_at DESC, portable_path DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...args);
	}
	const first = !after && query.section === 'inbox' && !terms.length && !query.id && !encrypted;
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
		const unindexed = terms.length ? await unindexedCards(env, query.section, after, cursor && last ? [last.saved_at, last.portable_path] : null) : [];
		return { cards: results.map(card), ...terms.length ? { unindexed: unindexed.map(card) } : {}, cursor };
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
	const { results } = await env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM reading_items
    WHERE ${where.join(' AND ')} ORDER BY saved_at DESC, portable_path DESC LIMIT ${MAX_UNINDEXED}`).bind(...args).all<ItemsRow>();
	return results;
}
