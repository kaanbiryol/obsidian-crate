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
import { ARTICLE_EDITED_ERROR, readingIndexScope } from './library-index';

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
// A search starts from its rarest term, found by counting each term's notes up to these caps:
// a small one first, and a larger one only when every term reaches it.
const TERM_PROBES = [50, 500];
/** Usually small sections, each with its own index ordered newest first. When one holds fewer
 * notes than the first cap and than every term, a search walks it instead of a term. */
const WALKABLE_SECTIONS = new Set<ReadingSection | 'all'>(['favorites', 'highlights']);

/** The term with the fewest notes, or null to walk the section, by capped counts. Each count
 * reads at most its cap; a single term outside a walkable section needs none. When every term
 * is common at both caps, the first term is kept. */
async function searchDriver(env: Env, terms: string[], section: ReadingSection | 'all'): Promise<string | null> {
	const walkable = WALKABLE_SECTIONS.has(section);
	if (terms.length === 1 && !walkable) return terms[0]!;
	for (const [stage, cap] of TERM_PROBES.entries()) {
		const probeTerms = terms.length > 1, probeSection = walkable && stage === 0;
		if (!probeTerms && !probeSection) break;
		const results = await env.DB.batch<Rows<{ n: number }>>([
			...probeTerms ? terms.map(term => env.DB.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM note_terms WHERE term = ? LIMIT ${cap})`).bind(term)) : [],
			...probeSection ? [env.DB.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM reading_items WHERE ${SECTION_FILTERS[section]} LIMIT ${cap})`)] : [],
		]);
		const counts = results.map(result => result.results[0]?.n ?? 0);
		const sectionCount = probeSection ? counts.pop()! : Infinity;
		const least = probeTerms ? Math.min(...counts) : Infinity;
		if (sectionCount < cap && sectionCount <= least) return null;
		if (least < cap) return terms[counts.indexOf(least)]!;
	}
	return terms[0]!;
}

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
	// confirms the whole word.
	const words = encrypted ? [] : searchWords(query.q ?? '', MAX_QUERY_WORDS);
	let identity: string | undefined;
	if (!encrypted && query.url) { try { identity = readingUrlIdentity(query.url); } catch { throw new ReadingError('Enter a valid web link.'); } }
	const terms = [...new Set(encrypted ? query.terms ?? [] : [...identity ? [`u:${identity}`] : [], ...query.tag ? [`t:${normalizedTag(query.tag)}`] : [], ...words.map(wordTerm)])];
	let page: D1PreparedStatement;
	if (terms.length) {
		// Each term lists its notes newest first, so the search walks one term and stops after a
		// page. The walk checks every other term with an exact key lookup in note_terms, where a
		// miss reads no row, so only entries with every term go on to read their note. It is a
		// subquery that LIMIT -1 keeps SQLite from merging: merged, SQLite reads the note first.
		const driver = await searchDriver(env, terms, query.section);
		const where = [SECTION_FILTERS[query.section], visible].map(clause => clause.replace(/\b(status|favorite|highlighted|card|metadata_json|duplicate)\b/g, 'i.$1')), args: unknown[] = [];
		if (query.id) { where.push('i.item_id = ?'); args.push(query.id); }
		// The row's word list is JSON text: a quote followed by a word's start confirms the title
		// without reading rows.
		for (const word of words) { where.push('instr(i.words, ?) > 0'); args.push(JSON.stringify(word).slice(0, -1)); }
		const columns = ITEM_COLUMNS.split(', ').map(column => `i.${column}`).join(', ');
		// Every other term is an exact key lookup in note_terms, where a miss reads no row.
		const has = (alias: string) => `EXISTS (SELECT 1 FROM note_terms o WHERE o.term = ? AND o.saved_at = ${alias}.saved_at AND o.portable_path = ${alias}.portable_path)`;
		if (driver === null) {
			// The section has the fewest notes: walk its index newest first and check each term.
			const walk = [...where], walkArgs: unknown[] = [];
			if (after) { walk.push('(i.saved_at, i.portable_path) < (?, ?)'); walkArgs.push(...after); }
			for (const term of terms) { walk.push(has('i')); walkArgs.push(term); }
			page = env.DB.prepare(`SELECT ${columns} FROM reading_items i WHERE ${walk.join(' AND ')}
      ORDER BY i.saved_at DESC, i.portable_path DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...args, ...walkArgs);
		} else {
			const walk = ['t.term = ?'], walkArgs: unknown[] = [driver];
			if (after) { walk.push('(t.saved_at, t.portable_path) < (?, ?)'); walkArgs.push(...after); }
			for (const term of terms) if (term !== driver) { walk.push(has('t')); walkArgs.push(term); }
			// CROSS JOIN keeps the walk outermost, so SQLite never scans the library instead.
			page = env.DB.prepare(`SELECT ${columns}
      FROM (SELECT t.saved_at, t.portable_path FROM note_terms t WHERE ${walk.join(' AND ')} ORDER BY t.saved_at DESC, t.portable_path DESC LIMIT -1) t
      CROSS JOIN reading_items i ON i.portable_path = t.portable_path
      WHERE ${where.join(' AND ')} ORDER BY t.saved_at DESC, t.portable_path DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...walkArgs, ...args);
		}
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
	const card = (row: ItemsRow) => ({ path: row.path, revision: row.storage_key, hash: row.hash, size: row.size, ...JSON.parse(row.card!) as { card: string }, stale: row.stale === 1,
		fields: { item_id: row.item_id, saved_at: row.saved_at, status: row.status, favorite: row.favorite === 1, highlighted: row.highlighted === 1 } });
	if (encrypted) return { cards: results.map(card), cursor };
	const listed = listedPage(current, results, queuedRows?.results ?? []);
	return { items: listed.items, issues: issueRows ? listedPage(current, issueRows.results, []).issues : [], cursor };
}
