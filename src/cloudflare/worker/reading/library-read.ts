import { armNotificationCoordinator } from '../notifications/lifecycle';
import type { Env } from '../types';
import { readingResponse, ReadingError, readStoredNote, policyStatement, readingItemId } from './common';
import { parseReadingItemsQuery, readingChanges, readingItem, readingItemStatements, readingItems, readingTags, parseReadingTagsSection, type ReadingItemRows } from './queries';
import { completeReadingIndex, ensureReadingIndex, readingIndexStatement, readingRevision, type ReadingIndexRow } from './library-index';
import type { ReadingPolicy } from '@/protocol/reading-policy';
import { MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES } from '@/encryption/file-inventory';

export interface LoadedLibraryRead { policy: ReadingPolicy | null; index: ReadingIndexRow | null; item?: ReadingItemRows }

/** Whether `request` reads the library: a page, its changes, one item or the tag list. */
export const isLibraryRead = (request: Request, path: string) => request.method === 'GET'
	&& (path === '/reading/item' || path === '/reading/items' || path === '/reading/changes' || path === '/reading/tags');

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
	const index = complete ?? await ensureReadingIndex(env, current, file => readStoredNote(env, file, encrypted ? MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES : undefined), loaded.index, encrypted);
	// Reads wake notification processing only to continue a rebuild or extract what it queued.
	if (index.rebuilt && state) await armNotificationCoordinator(state);
	if (index.state !== 'complete') throw new ReadingError('Your Reading library is not fully available yet. Try refreshing shortly.', 503);
	// A rebuild step changed the rows read before it.
	// One small page, so it is answered outside the lock.
	// A rebuild step in this request moved the revision the request read before it.
	const revision = index.rebuilt ? await readingIndexStatement(env.DB).first<ReadingIndexRow>() : loaded.index;
	if (path === '/reading/items') return readingResponse(await readingItems(env, current, encrypted, parseReadingItemsQuery(url.searchParams, encrypted), readingRevision(revision)));
	if (path === '/reading/changes') return readingResponse(await readingChanges(env, current, encrypted, url.searchParams.get('since'), revision));
	if (path === '/reading/tags') return readingResponse(await readingTags(env, encrypted, parseReadingTagsSection(url.searchParams)));
	if (path === '/reading/item') return await readingItem(env, current, url.searchParams.get('id'), request.headers.get('If-None-Match'), index.rebuilt ? undefined : loaded.item);
	return readingResponse({ error: 'Not found' }, 404);
}
