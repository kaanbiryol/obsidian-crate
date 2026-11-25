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
import { ARTICLE_EDITED_ERROR, isReadingNotePath, readingIndexScope, readingRevision, type ReadingIndexRow } from './library-index';
import { portablePathKey } from '@/protocol/portable-path';

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

interface ReadingRow { id: number; portable_path: string; path: string; metadata_json: string | null; error: string | null; article_edited: number; duplicate: number; saved_at: string }
const ROW_COLUMNS = 'id, portable_path, path, metadata_json, error, article_edited, duplicate, saved_at';
const queuedStatement = (env: Env, current: ReadingPolicy) =>
	env.DB.prepare('SELECT note FROM reading_captures WHERE generation=? ORDER BY available_at LIMIT 1000').bind(current.generation);

function listedPage(current: ReadingPolicy, rows: ReadingRow[], queued: Array<{ note: string }>) {
	const issue = (row: ReadingRow) => row.error
		?? (row.article_edited && current.enabled ? ARTICLE_EDITED_ERROR : null)
		?? (row.duplicate ? READING_DUPLICATE_ID_ISSUE : null);
	return { items: [...queued.map(row => ({ ...parseReadingNote(row.note)!, path: '' })), ...rows.filter(row => row.metadata_json && !row.duplicate).map(row => ({ ...validateReadingMetadata(JSON.parse(row.metadata_json!) as Record<string, unknown>), path: row.path }))],
		issues: rows.flatMap(row => { const message = issue(row); return message ? [{ path: row.path, message }] : []; }) };
}

/** The cursor is the last row's sort key and row id, opaque to clients. A search's cursor
 * also names the term its walk follows (an index into its terms, or -1 for the section), so
 * later pages skip choosing it again. */
function parseListCursor(cursor: string): { after: [string, number]; driver?: number } | null {
	if (!cursor) return null;
	let value: unknown;
	try { value = cursor.length <= 4096 ? JSON.parse(cursor) : null; } catch { value = null; }
	if (!Array.isArray(value) || value.length < 2 || value.length > 3 || typeof value[0] !== 'string' || !Number.isSafeInteger(value[1])
		|| value.length === 3 && !Number.isSafeInteger(value[2])) throw new ReadingError('Invalid library cursor.');
	return { after: [value[0], value[1] as number], ...value.length === 3 ? { driver: value[2] as number } : {} };
}

/** One page of the library view. Small, so a visit reads about one page of rows. */
const READING_ITEMS_PAGE = 50;
const MAX_READING_QUERY_TERMS = 10;
/** `all` lists every section, for a link or ID lookup. */
const SECTION_FILTERS: Record<Exclude<ReadingSection, 'highlights'> | 'all', string> = {
	inbox: "status = 'inbox'", archived: "status = 'archived'", favorites: 'favorite = 1', all: 'status IS NOT NULL',
};
/** An encrypted page sends each card with the fields it was sorted and filtered by; a plaintext
 * page reads `ROW_COLUMNS`. */
const CARD_COLUMNS = 'id, portable_path, path, saved_at, card, storage_key, stale, hash, size, item_id, status, favorite, highlighted_at';
// A search starts from its rarest term, found by counting each term's notes up to these caps:
// a small one first, and a larger one only when every term reaches it, for the first
// LARGE_PROBE_TERMS terms. The first page chooses; its cursor keeps the choice.
const TERM_PROBES = [50, 500];
const LARGE_PROBE_TERMS = 3;
/** Usually small sections, each with its own index ordered newest first. When one holds fewer
 * notes than the first cap and than every term, a search walks it instead of a term. */
const WALKABLE_SECTIONS = new Set<ReadingSection | 'all'>(['favorites']);

/** The term with the fewest notes, or null to walk the section, by capped counts. Each count
 * reads at most its cap; a single term outside a walkable section needs none. When every term
 * is common at both caps, the first term is kept. */
async function searchDriver(env: Env, terms: string[], section: keyof typeof SECTION_FILTERS): Promise<string | null> {
	const walkable = WALKABLE_SECTIONS.has(section);
	if (terms.length === 1 && !walkable) return terms[0]!;
	for (const [stage, cap] of TERM_PROBES.entries()) {
		const probeTerms = terms.length > 1, probeSection = walkable && stage === 0;
		if (!probeTerms && !probeSection) break;
		const probed = stage === 0 ? terms : terms.slice(0, LARGE_PROBE_TERMS);
		const results = await env.DB.batch<Rows<{ n: number }>>([
			...probeTerms ? probed.map(term => env.DB.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM note_terms WHERE term = ? LIMIT ${cap})`).bind(term)) : [],
			...probeSection ? [env.DB.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM reading_items WHERE ${SECTION_FILTERS[section]} LIMIT ${cap})`)] : [],
		]);
		const counts = results.map(result => result.results[0]?.n ?? 0);
		const sectionCount = probeSection ? counts.pop()! : Infinity;
		const least = probeTerms ? Math.min(...counts) : Infinity;
		if (sectionCount < cap && sectionCount <= least) return null;
		if (least < cap) return probed[counts.indexOf(least)]!;
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
	if (!(section in SECTION_FILTERS) && section !== 'highlights') throw new ReadingError('Unknown Reading section.');
	const text = (name: string, max: number) => { const value = params.get(name) ?? ''; if (value.length > max) throw new ReadingError('Search is too long.'); return value || undefined; };
	const id = params.get('id');
	const common = { section: section as ReadingSection | 'all', cursor: params.get('cursor') ?? '', ...id !== null ? { id: readingItemId(id) } : {} };
	if (!encrypted) return { ...common, q: text('q', 500), tag: text('tag', 500), url: text('url', 8192) };
	const terms = params.getAll('term');
	if (terms.length > MAX_READING_QUERY_TERMS || !terms.every(isHashedReadingTerm)) throw new ReadingError('Invalid search terms.');
	return { ...common, terms };
}

interface CardRow extends Pick<ReadingRow, 'id' | 'portable_path' | 'path' | 'saved_at'> { card: string | null; storage_key: string; stale: number; hash: string; size: number; item_id: string; status: string; favorite: number; highlighted_at: string | null }

type PageRows = [Array<ReadingRow | CardRow>, string | null];

/** Newest first. Each term narrows the page through `note_terms`, so a search reads the
 * notes it matches, not the library. The first unfiltered inbox page carries the capture queue
 * and the issues; an encrypted page carries each card for the device to open. The Highlights
 * tab pages `highlight_index` instead (`highlightPage`). */
export async function readingItems(env: Env, current: ReadingPolicy, encrypted: boolean, query: ReadingItemsQuery, revision?: string) {
	const cursorAt = parseListCursor(query.cursor), after = cursorAt?.after ?? null;
	if (query.section === 'highlights') {
		const [results, cursor] = await highlightPage(env, encrypted, query, after);
		return { ...listedResponse(current, encrypted, results, cursor), ...revision ? { revision } : {} };
	}
	const section = query.section;
	const visible = encrypted ? 'card IS NOT NULL' : 'metadata_json IS NOT NULL AND duplicate = 0';
	// A query word matches by its term (its first three letters); an unencrypted title then
	// confirms the whole word.
	const words = encrypted ? [] : searchWords(query.q ?? '', MAX_QUERY_WORDS);
	let identity: string | undefined;
	if (!encrypted && query.url) { try { identity = readingUrlIdentity(query.url); } catch { throw new ReadingError('Enter a valid web link.'); } }
	const terms = queryTerms(encrypted, query, words, identity);
	const itemColumns = encrypted ? CARD_COLUMNS : ROW_COLUMNS;
	let page: D1PreparedStatement, walkEnd: D1PreparedStatement | null = null, chosen: number | undefined;
	if (terms.length) {
		// Each term lists its notes newest first, so the search walks one term and stops after a
		// page. The walk checks every other term with an exact key lookup in note_terms, where a
		// miss reads no row, so only entries with every term go on to read their note. It is a
		// subquery that LIMIT -1 keeps SQLite from merging: merged, SQLite reads the note first.
		const kept = cursorAt?.driver;
		const driver = kept !== undefined && kept >= -1 && kept < terms.length ? kept < 0 ? null : terms[kept]! : await searchDriver(env, terms, section);
		chosen = driver === null ? -1 : terms.indexOf(driver);
		const where = [SECTION_FILTERS[section], visible].map(clause => clause.replace(/\b(status|favorite|card|metadata_json|duplicate)\b/g, 'i.$1')), args: unknown[] = [];
		if (query.id) { where.push('i.item_id = ?'); args.push(query.id); }
		// The row's word list is JSON text: a quote followed by a word's start confirms the title
		// without reading rows.
		for (const word of words) { where.push('instr(i.words, ?) > 0'); args.push(wordStart(word)); }
		const columns = itemColumns.split(', ').map(column => `i.${column}`).join(', ');
		// Every other term is an exact key lookup in note_terms, where a miss reads no row.
		const has = (alias: string, item: string) => `EXISTS (SELECT 1 FROM note_terms o WHERE o.term = ? AND o.saved_at = ${alias}.saved_at AND o.item = ${alias}.${item})`;
		if (driver === null) {
			// The section has the fewest notes: walk its index newest first and check each term.
			const walk = [...where], walkArgs: unknown[] = [];
			if (after) { walk.push('(i.saved_at, i.id) < (?, ?)'); walkArgs.push(...after); }
			for (const term of terms) { walk.push(has('i', 'id')); walkArgs.push(term); }
			page = env.DB.prepare(`SELECT ${columns} FROM reading_items i WHERE ${walk.join(' AND ')}
      ORDER BY i.saved_at DESC, i.id DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...args, ...walkArgs);
		} else {
			const walk = ['t.term = ?'], walkArgs: unknown[] = [driver], others: string[] = [], otherArgs: unknown[] = [];
			if (after) { walk.push('(t.saved_at, t.item) < (?, ?)'); walkArgs.push(...after); }
			for (const term of terms) if (term !== driver) { others.push(has('t', 'item')); otherArgs.push(term); }
			// CROSS JOIN keeps the walk outermost, so SQLite never scans the library instead. The
			// innermost walk reads at most TERM_SCAN entries of one term; the other terms are key
			// lookups on those entries before any note is read. LIMIT -1 keeps SQLite from merging.
			const scan = `SELECT t.saved_at, t.item FROM note_terms t WHERE ${walk.join(' AND ')} ORDER BY t.saved_at DESC, t.item DESC LIMIT ${TERM_SCAN}`;
			page = env.DB.prepare(`SELECT ${columns}
      FROM (SELECT t.saved_at, t.item FROM (${scan}) t ${others.length ? `WHERE ${others.join(' AND ')}` : ''} ORDER BY t.saved_at DESC, t.item DESC LIMIT -1) t
      CROSS JOIN reading_items i ON i.id = t.item
      WHERE ${where.join(' AND ')} ORDER BY t.saved_at DESC, t.item DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...walkArgs, ...otherArgs, ...args);
			walkEnd = env.DB.prepare(`SELECT saved_at, item AS id FROM note_terms t WHERE ${walk.join(' AND ')}
      ORDER BY t.saved_at DESC, t.item DESC LIMIT 1 OFFSET ${TERM_SCAN - 1}`).bind(...walkArgs);
		}
	} else {
		const where = [SECTION_FILTERS[section], visible], args: unknown[] = [];
		if (after) { where.push('(saved_at, id) < (?, ?)'); args.push(...after); }
		if (query.id) { where.push('item_id = ?'); args.push(query.id); }
		page = env.DB.prepare(`SELECT ${itemColumns} FROM reading_items WHERE ${where.join(' AND ')}
      ORDER BY saved_at DESC, id DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...args);
	}
	const first = !after && section === 'inbox' && !terms.length && !query.id && !encrypted;
	const [{ results }, queuedRows, issueRows] = await env.DB.batch(first ? [page, queuedStatement(env, current),
		env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM reading_items WHERE error IS NOT NULL OR duplicate = 1 OR article_edited = 1 LIMIT 1000`)] : [page]) as [Rows<ReadingRow | CardRow>, Rows<{ note: string }>?, Rows<ReadingRow>?];
	const listed = withinPageBytes(results);
	// A short page either reached the end of the walk or its cap; at the cap the next page
	// continues after the last entry read. The end is a second seek, needed only then.
	const end = results.length < READING_ITEMS_PAGE && walkEnd ? await walkEnd.first<{ saved_at: string; id: number }>() : null;
	const key = listed.length < results.length || results.length === READING_ITEMS_PAGE ? listed.at(-1) : end;
	const cursor = key ? JSON.stringify(chosen === undefined ? [key.saved_at, key.id] : [key.saved_at, key.id, chosen]) : null;
	return { ...listedResponse(current, encrypted, listed, cursor, queuedRows?.results, issueRows?.results), ...revision ? { revision } : {} };
}

/** Changelog entries a changes request reads at most; past them the client reloads its first page. */
const READING_CHANGES = 500;

/** What changed in the library since revision `since`: the notes the changelog names in the
 * Reading folder, and every note sharing their Reading IDs, whose duplicate flags they can
 * change. Listed notes come back as items (cards in an encrypted vault) and the rest of the
 * changed paths as `removed`. Another epoch, a pruned changelog or more than READING_CHANGES
 * entries answer `reset`. Nothing changed reads only the index row the request already read. */
export async function readingChanges(env: Env, current: ReadingPolicy, encrypted: boolean, since: string | null, index: ReadingIndexRow | null) {
	const revision = readingRevision(index), match = /^(\d{1,15})\.(\d{1,15})$/.exec(since ?? '');
	const changed = index?.changed ?? 0, after = match ? Number(match[2]) : NaN;
	if (!match || Number(match[1]) !== (index?.epoch ?? 0) || after > changed) return { revision, reset: true };
	const none = encrypted ? { revision, cards: [], removed: [] } : { revision, items: [], issues: [], removed: [] };
	if (after === changed) return none;
	const [entries, state] = await env.DB.batch<{ results: Array<{ path?: string; floor?: number | null }> }>([
		env.DB.prepare(`SELECT path FROM changelog WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ${READING_CHANGES + 1}`).bind(after, changed),
		env.DB.prepare('SELECT changelog_floor AS floor FROM server_state WHERE id = 1'),
	]);
	if (entries!.results.length > READING_CHANGES || (state!.results[0]?.floor ?? 0) > after) return { revision, reset: true };
	const paths = [...new Set(entries!.results.map(entry => entry.path!).filter(path => isReadingNotePath(path, current.folder_path)))];
	if (!paths.length) return none;
	const { results } = await env.DB.prepare(`SELECT ${encrypted ? CARD_COLUMNS : ROW_COLUMNS} FROM reading_items
      WHERE portable_path IN (SELECT value FROM json_each(?1))
        OR item_id IN (SELECT item_id FROM reading_items WHERE portable_path IN (SELECT value FROM json_each(?1)) AND item_id IS NOT NULL)`)
		.bind(JSON.stringify(paths.map(portablePathKey))).all<ReadingRow & CardRow>();
	const changedPaths = [...new Set([...paths, ...results.map(row => row.path)])];
	if (encrypted) {
		const { cards } = listedResponse(current, true, results.filter(row => row.card !== null), null) as { cards: Array<{ path: string }> };
		const listed = new Set(cards.map(card => card.path));
		return { revision, cards, removed: changedPaths.filter(path => !listed.has(path)) };
	}
	const page = listedPage(current, results, []), listed = new Set(page.items.map(item => item.path));
	return { revision, items: page.items, issues: page.issues, removed: changedPaths.filter(path => !listed.has(path)) };
}

/** The terms a query must match: hashed by the device in an encrypted vault, otherwise its
 * link, tag and query words. */
function queryTerms(encrypted: boolean, query: ReadingItemsQuery, words: string[], identity?: string): string[] {
	return [...new Set(encrypted ? query.terms ?? [] : [...identity ? [`u:${identity}`] : [], ...query.tag ? [`t:${normalizedTag(query.tag)}`] : [], ...words.map(wordTerm)])];
}

/** A word's start in a JSON word list: its opening quote and letters, without the closing quote. */
const wordStart = (word: string) => JSON.stringify(word).slice(0, -1);

function listedResponse(current: ReadingPolicy, encrypted: boolean, results: Array<ReadingRow | CardRow>, cursor: string | null, queued: Array<{ note: string }> = [], issues?: ReadingRow[]) {
	// The device checks the fields the page was sorted and filtered by against each card.
	const card = (row: CardRow) => ({ path: row.path, revision: row.storage_key, hash: row.hash, size: row.size, ...JSON.parse(row.card!) as { card: string }, stale: row.stale === 1,
		fields: { item_id: row.item_id, saved_at: row.saved_at, status: row.status, favorite: row.favorite === 1, highlighted: row.highlighted_at !== null } });
	if (encrypted) return { cards: (results as CardRow[]).map(card), cursor };
	const listed = listedPage(current, results as ReadingRow[], queued);
	return { items: listed.items, issues: issues ? listedPage(current, issues, []).issues : [], cursor };
}

/** Term entries a search page walks at most; a short page's cursor continues the walk. */
const TERM_SCAN = 1000;
/** Rows a filtered Highlights page reads at most. A highlight search checks each note's terms
 * in its row, so a search that matches few notes stops here and its cursor continues the scan. */
const HIGHLIGHT_SCAN = 2000;
/** A page ends before its listed notes pass this size: each note carries every highlight it
 * holds, up to 48 KB, and an encrypted card up to 256 KB. */
const LIST_PAGE_BYTES = 512 * 1024;
/** The rows of a page up to LIST_PAGE_BYTES, always at least one. */
function withinPageBytes<Row extends { metadata_json?: string | null; card?: string | null }>(rows: Row[]): Row[] {
	let bytes = 0, count = 0;
	for (const row of rows) {
		bytes += (row.metadata_json?.length ?? 0) + (row.card?.length ?? 0);
		if (count && bytes > LIST_PAGE_BYTES) break;
		count++;
	}
	return count === rows.length ? rows : rows.slice(0, count);
}

/** One Highlights page, newest highlighted first. Every term must appear in the note's
 * highlight terms (its title, highlight and note words, and tags); an unencrypted note's whole
 * words confirm each query word. The device or the web app then shows the matching highlights. */
async function highlightPage(env: Env, encrypted: boolean, query: ReadingItemsQuery, after: [string, number] | null): Promise<PageRows> {
	const visible = encrypted ? 'i.card IS NOT NULL' : 'i.metadata_json IS NOT NULL AND i.duplicate = 0';
	const words = encrypted ? [] : searchWords(query.q ?? '', MAX_QUERY_WORDS), terms = queryTerms(encrypted, query, words);
	const columns = [...new Set([...(encrypted ? CARD_COLUMNS : ROW_COLUMNS).split(', '), 'highlighted_at'])];
	const range = after ? 'WHERE (highlighted_at, item) < (?, ?)' : '', rangeArgs = after ?? [];
	type HighlightRow = Partial<ReadingRow & CardRow> & Pick<ReadingRow, 'id' | 'portable_path'> & { highlighted_at: string };
	const listed = columns.map(column => column === 'highlighted_at' ? 'h.highlighted_at' : `i.${column}`).join(', ');
	// The walk is a subquery that LIMIT keeps SQLite from merging, so it reads its index rows
	// first and each note only once it matches.
	const page = async (scan: string, where: string[], args: unknown[]) => (await env.DB.prepare(`SELECT ${listed}
      FROM (SELECT highlighted_at, item, terms, words FROM highlight_index ${range} ORDER BY highlighted_at DESC, item DESC LIMIT ${scan}) h
      CROSS JOIN reading_items i ON i.id = h.item WHERE ${[...where, visible].join(' AND ')}
      ORDER BY h.highlighted_at DESC, h.item DESC LIMIT ${READING_ITEMS_PAGE}`).bind(...rangeArgs, ...args).all<HighlightRow>()).results;
	let hits: HighlightRow[], end: { highlighted_at: string; id: number } | null = null;
	if (!terms.length) hits = await page('-1', [], []);
	else {
		hits = await page(String(HIGHLIGHT_SCAN), [...terms.map(() => 'instr(h.terms, ?) > 0'), ...words.map(() => 'instr(h.words, ?) > 0')],
			[...terms.map(term => JSON.stringify(term)), ...words.map(wordStart)]);
		// A short page either reached the end or the scan's cap; at the cap the next page
		// continues after the last scanned row. D1 counts temporary tables as rows read, so the
		// end is a second seek, needed only for a short page, rather than a window over the scan.
		if (hits.length < READING_ITEMS_PAGE) end = await env.DB.prepare(`SELECT highlighted_at, item AS id FROM highlight_index ${range}
      ORDER BY highlighted_at DESC, item DESC LIMIT 1 OFFSET ${HIGHLIGHT_SCAN - 1}`).bind(...rangeArgs).first();
	}
	const listedRows = withinPageBytes(hits);
	const last = listedRows.at(-1);
	const key = listedRows.length < hits.length || hits.length === READING_ITEMS_PAGE ? last : end;
	return [listedRows as Array<ReadingRow | CardRow>, key ? JSON.stringify([key.highlighted_at, key.id]) : null];
}

/** Most tags the tag list returns. */
const MAX_READING_TAGS = 5000;

export type ReadingTagsResponse = { tags: string[]; counts?: number[] } | { sealed: Array<{ term: string; name: string; count?: number }> };

/** The section a tag list counts its notes in, or null for the whole library. */
export function parseReadingTagsSection(params: URLSearchParams): ReadingSection | null {
	const section = params.get('section');
	if (section === null) return null;
	if (section === 'all' || (section !== 'highlights' && !(section in SECTION_FILTERS))) throw new ReadingError('Unknown Reading section.');
	return section as ReadingSection;
}

/** Every tag in the library, for the tags view. An unencrypted vault steps through the distinct
 * `t:` terms in note_terms, one index seek per tag, so the list reads about one row per tag, not
 * one per tagged note. An encrypted vault lists the sealed names devices posted; the device
 * opens them.
 *
 * With a `section`, only tags of notes listed there come back, most used first, each with its
 * note count, from the counts each commit keeps: about one row per tag, at any library size. */
export async function readingTags(env: Env, encrypted: boolean, section: ReadingSection | null = null): Promise<ReadingTagsResponse> {
	if (section) {
		if (encrypted) {
			const { results } = await env.DB.prepare(`SELECT c.term, r.name, c.count FROM reading_tag_counts c CROSS JOIN reading_tags r ON r.term = c.term
      WHERE c.section = ? AND c.count > 0 ORDER BY c.count DESC, c.term LIMIT ${MAX_READING_TAGS}`).bind(section).all<{ term: string; name: string; count: number }>();
			return { sealed: results };
		}
		const { results } = await env.DB.prepare(`SELECT term, count FROM reading_tag_counts WHERE section = ? AND count > 0
      ORDER BY count DESC, term LIMIT ${MAX_READING_TAGS}`).bind(section).all<{ term: string; count: number }>();
		return { tags: results.map(row => row.term.slice(2)), counts: results.map(row => row.count) };
	}
	if (encrypted) {
		const { results } = await env.DB.prepare(`SELECT term, name FROM reading_tags LIMIT ${MAX_READING_TAGS}`).all<{ term: string; name: string }>();
		return { sealed: results };
	}
	const { results } = await env.DB.prepare(`WITH RECURSIVE tags(term) AS (
      SELECT (SELECT term FROM note_terms WHERE term > 't:' AND term < 't;' ORDER BY term LIMIT 1)
      UNION ALL SELECT (SELECT term FROM note_terms WHERE term > tags.term AND term < 't;' ORDER BY term LIMIT 1) FROM tags WHERE tags.term IS NOT NULL)
    SELECT term FROM tags WHERE term IS NOT NULL LIMIT ${MAX_READING_TAGS}`).all<{ term: string }>();
	return { tags: results.map(row => row.term.slice(2)) };
}
