import { armNotificationCoordinator } from '../notifications/lifecycle';
import type { Env } from '../types';
import { readingResponse, ReadingError, readStoredNote, policyStatement, readingItemId } from './common';
import { parseReadingItemsQuery, readingItem, readingItemStatements, readingItems, type ReadingItemRows } from './queries';
import { completeReadingIndex, ensureReadingIndex, readingIndexStatement, type ReadingIndexRow } from './library-index';
import type { ReadingPolicy } from '@/protocol/reading-policy';

export interface LoadedLibraryRead { policy: ReadingPolicy | null; index: ReadingIndexRow | null; item?: ReadingItemRows }

/** Whether `request` reads the library: a page or one item. */
export const isLibraryRead = (request: Request, path: string) => request.method === 'GET' && (path === '/reading/item' || path === '/reading/items');

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
	return readingResponse({ error: 'Not found' }, 404);
}
