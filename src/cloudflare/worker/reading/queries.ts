import type { Env } from '../types';
import { ReadingError, readingItemId, readingNotModified, readingResponse, readSourceRow, sourceRowsStatement, uniqueSourceRow, type ReadingSourceRow } from './common';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { parseReadingNote } from '@/reading/core/notes';
import { READING_DUPLICATE_ID_ISSUE } from '@/reading/core/inventory';
import { validateReadingMetadata } from '@/reading/core/model';
import { sha256Hex } from '@/platform/sha256';
import { ARTICLE_EDITED_ERROR, readingIndexScope, readingIndexStatement, type ReadingIndexRow, type ReadingIndexState } from './library-index';

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

export interface ReadingRow { portable_path: string; path: string; metadata_json: string | null; error: string | null; article_edited: number; duplicate: number; saved_at: string }
export const ROW_COLUMNS = 'portable_path, path, metadata_json, error, article_edited, duplicate, saved_at';
export const queuedStatement = (env: Env, current: ReadingPolicy) =>
	env.DB.prepare('SELECT note FROM reading_captures WHERE generation=? ORDER BY available_at LIMIT 1000').bind(current.generation);

export function listedPage(current: ReadingPolicy, rows: ReadingRow[], queued: Array<{ note: string }>) {
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
