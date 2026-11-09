import { armNotificationCoordinator } from '../notifications/lifecycle';
import type { Env } from '../types';
import { readingResponse, ReadingError, readStoredNote, policyStatement, readingItemId, readingNotModified } from './common';
import { parseReadingItemsQuery, readingItems } from './queries';
import { etagMatches, readingDeltaBase, readingItem, readingItemStatements, readingList, readingListDelta, readingListEtag, type ReadingItemRows } from './queries';
import { parseDeltaBase } from '../sync/change-token';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import { completeReadingIndex, ensureReadingIndex, readingIndexStatement, type ReadingIndexRow } from './library-index';
import type { ReadingPolicy } from '@/protocol/reading-policy';

export interface LoadedLibraryRead { policy: ReadingPolicy | null; index: ReadingIndexRow | null; item?: ReadingItemRows }

/** Whether `request` reads the library: a list page or one item. */
export const isLibraryRead = (request: Request, path: string) => request.method === 'GET' && (path === '/reading/item' || path === '/reading/list' || path === '/reading/items');

/** Library reads load the policy, index row and item rows in one round trip and one snapshot. */
export async function loadLibraryRead(db: D1Database, url: URL): Promise<LoadedLibraryRead> {
	const id = url.pathname === '/reading/item' ? url.searchParams.get('id') : null;
	let itemId: string | undefined;
	try { if (id !== null) itemId = readingItemId(id); } catch { /* Reported after the authority and index checks. */ }
	const [policyRow, indexRow, ...item] = await db.batch<{ results: unknown[] }>([policyStatement(db), readingIndexStatement(db), ...itemId ? readingItemStatements(db, itemId) : []]);
	return { policy: (policyRow!.results[0] ?? null) as ReadingPolicy | null, index: (indexRow!.results[0] ?? null) as ReadingIndexRow | null,
		...item.length ? { item: item as unknown as ReadingItemRows } : {} };
}

/** Answers a library read under `current` authority. `forward` runs it under the
 * coordinator lock instead; the public Worker passes it, so reads it can answer
 * from a complete index stay outside the lock. */
export async function readLibrary(request: Request, env: Env, current: ReadingPolicy, loaded: LoadedLibraryRead, state?: DurableObjectState, forward?: () => Promise<Response>, encrypted = false): Promise<Response> {
	const url = new URL(request.url), path = url.pathname;
	// Outside the lock, only a complete index is read; a rebuild step writes, so it runs under the lock.
	const complete = forward ? completeReadingIndex(current, loaded.index) : null;
	if (forward && !complete) return await forward();
	const index = complete ?? await ensureReadingIndex(env, current, file => readStoredNote(env, file), loaded.index, encrypted);
	// Reads wake notification processing only to continue a rebuild or extract what it queued.
	if (index.rebuilt && state) await armNotificationCoordinator(state);
	if (index.state !== 'complete') throw new ReadingError('Your Reading library is not fully available yet. Try refreshing shortly.', 503);
	// A rebuild step changed the rows read before it.
	// One small page, so it is answered outside the lock.
	if (path === '/reading/items') return readingResponse(await readingItems(env, current, encrypted, parseReadingItemsQuery(url.searchParams, encrypted)));
	if (path === '/reading/item') return await readingItem(env, current, url.searchParams.get('id'), request.headers.get('If-None-Match'), index.rebuilt ? undefined : loaded.item);
	// The first list page is conditional, so an unchanged library is one cheap request.
	const cursor = url.searchParams.get('cursor') ?? '';
	const etag = cursor ? null : await readingListEtag(current, index.revision);
	if (etag && etagMatches(request.headers.get('If-None-Match'), etag)) return readingNotModified(etag);
	// A page parses up to 1,000 notes, more CPU than the public Worker allows; the coordinator lists them.
	if (forward) return await forward();
	if (cursor) return readingResponse(await readingList(env, current, cursor), 200);
	// The base is the index position read before listing: later changes replay next time.
	const base = await readingDeltaBase(current, index), since = parseDeltaBase(url.searchParams.get('since'));
	const delta = since && since.scope === base.slice(base.indexOf('.') + 1) ? await readingListDelta(env, current, index, since.seq) : null;
	return readingResponse(delta ?? await readingList(env, current, ''), 200, { ETag: etag!, [DELTA_BASE_HEADER]: base });
}
