import { reportExpiredConnection, SESSION_RECOVERY_MESSAGE } from '../connection/expiration';
import { onReadingEncryptionReset } from './session/encryption-lifecycle';
import { prepareReadingEncryption, readingEncryptionHeaders, readingNoteFolder } from './session/encryption-session';
import { readCardIndex, readEncryptedReadingIndex, readReadingAttempt, writeCardIndex, writeEncryptedReadingIndex, writeReadingAttempt } from './storage/storage';
import { isReadingIndexCard } from './storage/cache';
import { openReadingIndexShard, type ReadingIndexCard } from '@/reading/core/card-index';
import { isReadingIndexHash, parseReadingIndexManifest, READING_INDEX_EMPTY_SHARD } from '@/protocol/reading-index';
import { filterUniqueReadingIds, READING_DUPLICATE_ID_ISSUE } from '@/reading/core/inventory';
import { cacheReadingArticle, commitReadingCache, readReadingArticle, readReadingCache, type ReadingCache } from './storage/storage';
import { assertReadingSession, type ReadingSession } from './session/session';
import { ReadingApiError } from './session/api-error';
import type { ReadingItem } from '@/reading/core/model';
import { ENCRYPTED_READING_ACTIONS, EncryptedReadingApi } from '@/pwa/reading/encrypted-api';
import { captureServerArticle } from './capture-article';
export { ReadingApiError } from './session/api-error';
import { isReadingArticle, isReadingItem, parseReadingListPage, type ReadingArticle, type ReadingListPage } from './storage/record-validation';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { isSha256Hex } from '@/platform/validation';
import type { FeatureKeys } from '../encryption/encryption-keys';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import { checkEncryptionSignals, EncryptionStateChangedError, retryAfterEncryptionChange } from '../encryption/encryption-retry';
import { responseError } from '../connection/response-error';
import { crateProtocol, crateRequestHeaders, forgetRefusedProtocol } from '../connection/request-headers';

const ENCRYPTED_READING_PATH = new RegExp(`^/reading/(?:${ENCRYPTED_READING_ACTIONS.join('|')})(?:\\?|$)`);
let encryptedClient: { identity: string; api: EncryptedReadingApi } | undefined;
onReadingEncryptionReset(() => { encryptedClient = undefined; });
async function rawReadingRequest(path: string, session: ReadingSession | null, body?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
	if (session) assertReadingSession(session);
	const method = body === undefined ? 'GET' : 'POST';
	const protocolHeaders = crateRequestHeaders(session?.token, await crateProtocol(path, method));
	if (session) assertReadingSession(session);
	const response = await fetch(path, { method, cache: 'no-store', signal: AbortSignal.timeout(20_000),
		headers: { ...protocolHeaders, ...session ? readingEncryptionHeaders() : {}, 'Content-Type': 'application/json', ...extraHeaders }, body });
	if (session) assertReadingSession(session);
	await forgetRefusedProtocol(response);
	if (session && response.status === 401) {
		reportExpiredConnection(session.token);
		throw new ReadingApiError(SESSION_RECOVERY_MESSAGE, 401);
	}
	checkEncryptionSignals(response, path, { probePath: '/reading/encryption', message: 'The encrypted Reading folder changed.' });
	return response;
}
export function readingRequest<T>(path: string, session: ReadingSession | null, body?: string): Promise<T> {
	return retryAfterEncryptionChange(refresh => preparedReadingRequest<T>(path, session, body, refresh));
}
/** The encrypted client for this session and key generation. */
function encryptedReadingApi(session: ReadingSession, keys: FeatureKeys): EncryptedReadingApi {
	const identity = JSON.stringify([session.token, session.id, session.generation, session.folderPath, keys.vaultId, keys.generation]);
	const indexIdentity = JSON.stringify([keys.vaultId, keys.generation, keys.folderPath]);
	if (encryptedClient?.identity !== identity) encryptedClient = { identity, api: new EncryptedReadingApi({
		captureArticle: url => captureServerArticle(url, body => rawReadingRequest('/reading/encrypted-extract', session, body)),
		folderPath: keys.folderPath, wireFolder: keys.wireFolder, paths: keys.paths, generation: keys.generation, authority: { vaultId: keys.vaultId, scopeId: 'vault', key: keys.vault, seal: keys.seal },
		request: (route, wire, headers) => rawReadingRequest(route, session, wire, headers),
		readAttempt: id => readReadingAttempt(session, id),
		writeAttempt: (id, attempt) => writeReadingAttempt(session, id, attempt),
		loadIndex: () => readEncryptedReadingIndex(session, indexIdentity, keys.folderPath),
		saveIndex: entries => writeEncryptedReadingIndex(session, indexIdentity, entries),
		loadCardIndex: () => readCardIndex(session, indexIdentity, keys.folderPath),
		saveCardIndex: (state, shards, added) => writeCardIndex(session, { ...state, identity: indexIdentity }, shards, added),
		isCard: (value): value is ReadingIndexCard => isReadingIndexCard(value, keys.folderPath),
		error: (message, status, code) => new ReadingApiError(message, status, code),
	}) };
	return encryptedClient.api;
}
async function preparedReadingRequest<T>(path: string, session: ReadingSession | null, body?: string, refresh = false): Promise<T> {
	if (session) {
		const keys = await prepareReadingEncryption(session, refresh, body !== undefined);
		if (keys && ENCRYPTED_READING_PATH.test(path)) {
			const value = await encryptedReadingApi(session, keys).request(path, body); assertReadingSession(session);
			return value as T;
		}
		if (!keys) encryptedClient = undefined;
	}
	return await readingResponseJson(await rawReadingRequest(path, session, body), session) as T;
}

/** A response's JSON body, once the session it answered is still current. A failed
 * response raises its server message as a `ReadingApiError`. */
async function readingResponseJson(response: Response, session: ReadingSession | null): Promise<unknown> {
	const failure = response.ok ? null : await responseError(response, 'Reading request failed.');
	const data: unknown = failure ? null : await response.json();
	if (session) assertReadingSession(session);
	if (failure) throw new ReadingApiError(failure.message, response.status, failure.code);
	return data;
}

/** Longest revision, ETag or delta base kept from a response. */
const MAX_REVISION_LENGTH = 128;
const keptRevision = (value: string | null | undefined): string | undefined =>
	value && value.length <= MAX_REVISION_LENGTH ? value : undefined;
export const MAX_READING_LIST_ITEMS = 100_000;
export const MAX_READING_LIST_ISSUES = 10_000;
export const MAX_READING_LIST_PAGES = 1100;

/** The first plaintext page carries the library ETag and delta base. An unchanged
 * library answers 304, so polling does not page through and rewrite every item; a
 * changed one with a delta base answers with only the changed notes. */
async function firstReadingListPage(session: ReadingSession, previous?: ReadingCache): Promise<{ unchanged: true } | { unchanged: false; response: unknown; revision?: string; deltaBase?: string }> {
	const unconditional = async () => ({ unchanged: false as const, response: await readingRequest<unknown>('/reading/list', session) });
	if (await prepareReadingEncryption(session)) {
		// The encrypted client answers an unchanged vault from its confirmed inventory.
		const response = await readingRequest<unknown>('/reading/list', session);
		const revision = response && typeof response === 'object' && typeof (response as { revision?: unknown }).revision === 'string'
			? (response as { revision: string }).revision : undefined;
		if (revision && previous && previous.revision === revision) return { unchanged: true };
		const kept = keptRevision(revision);
		return { unchanged: false, response, ...(kept ? { revision: kept } : {}) };
	}
	const path = previous?.deltaBase ? `/reading/list?since=${encodeURIComponent(previous.deltaBase)}` : '/reading/list';
	let response: Response;
	try { response = await rawReadingRequest(path, session, undefined, previous?.revision ? { 'If-None-Match': previous.revision } : {}); }
	catch (error) { if (error instanceof EncryptionStateChangedError) return unconditional(); throw error; }
	if (response.status === 304 && previous) return { unchanged: true };
	const data = await readingResponseJson(response, session);
	const revision = keptRevision(response.headers.get('ETag')), deltaBase = keptRevision(response.headers.get(DELTA_BASE_HEADER));
	return { unchanged: false, response: data, ...(revision ? { revision } : {}), ...(deltaBase ? { deltaBase } : {}) };
}

/** Replaces the previous copy's notes at `changedPaths` and its whole capture queue
 * (items without a path). Null when the result is inconsistent, so a full list is read. */
function mergeReadingDelta(previous: ReadingCache, page: ReadingListPage & { changedPaths: string[] }): Pick<ReadingCache, 'items' | 'issues'> | null {
	const changed = new Set(page.changedPaths);
	if (!page.items.every(item => !item.path || changed.has(item.path)) || !page.issues.every(issue => changed.has(issue.path))) return null;
	const items = [...page.items, ...previous.items.filter(item => item.path && !changed.has(item.path))];
	const issues = [...previous.issues.filter(issue => !changed.has(issue.path)), ...page.issues];
	if (items.length > MAX_READING_LIST_ITEMS || issues.length > MAX_READING_LIST_ISSUES
		|| new Set(items.map(item => item.crate_reading_id)).size !== items.length) return null;
	return { items, issues };
}

// Shards download a few at a time.
const SHARD_CONCURRENCY = 6;

/**
 * A first load from the card index Obsidian publishes: the manifest, every shard, and the
 * notes changed since its basis, which also return the list ETag and change base, so later
 * refreshes use the ordinary list delta. Reads a few rows instead of one per note. Null
 * when the server has no index or cannot replay its tail, so the caller lists every page.
 */
async function loadReadingFromIndex(session: ReadingSession): Promise<ReadingCache | null> {
	const folder = readingNoteFolder(session);
	const response = await rawReadingRequest('/reading/index', session);
	if (response.status === 404) return null;
	const answer = await readingResponseJson(response, session) as { manifest?: unknown };
	const manifest = parseReadingIndexManifest(answer.manifest);
	// An encrypted index is read by the encrypted client.
	if (!manifest || manifest.keyGeneration !== undefined) return null;
	const cards: ReadingIndexCard[] = [];
	const shards = manifest.shards.flatMap((hash, shard) => hash === READING_INDEX_EMPTY_SHARD ? [] : [{ hash, shard }]);
	await mapBounded(shards, SHARD_CONCURRENCY, async ({ hash, shard }) => {
		if (!isReadingIndexHash(hash)) throw new Error('Reading index is unreadable.');
		const download = await rawReadingRequest(`/reading/index/shard?hash=${hash}`, session);
		if (!download.ok) throw new ReadingApiError('Reading index is unavailable. Refresh to retry.', download.status);
		const bytes = new Uint8Array(await download.arrayBuffer());
		if (await sha256Hex(bytes) !== hash) throw new Error('Reading index failed verification.');
		const opened = await openReadingIndexShard(bytes, shard, manifest.generation);
		if (!opened.every(card => isReadingIndexCard(card, folder))) throw new Error('Reading index is unreadable.');
		cards.push(...opened);
	});
	assertReadingSession(session);
	const tail = await readingRequest<unknown>(`/reading/index/changes?after=${manifest.basis}`, session);
	if (!tail || typeof tail !== 'object' || 'expired' in tail || 'tooMany' in tail) return null;
	const { revision, deltaBase, ...changes } = tail as { revision?: unknown; deltaBase?: unknown; notes?: unknown; issues?: unknown; changedPaths?: unknown };
	const page = parseReadingListPage({ delta: true, items: changes.notes, issues: changes.issues, changedPaths: changes.changedPaths, cursor: null }, folder);
	if (!page?.changedPaths || typeof revision !== 'string' || typeof deltaBase !== 'string' || revision.length > MAX_REVISION_LENGTH || deltaBase.length > MAX_REVISION_LENGTH) {
		throw new Error('Reading index changes are unreadable.');
	}
	const { unique, duplicates } = filterUniqueReadingIds(cards.map(({ wire: _wire, ...item }) => item));
	const merged = mergeReadingDelta({ items: unique, issues: duplicates.map(item => ({ path: item.path, message: READING_DUPLICATE_ID_ISSUE })), savedAt: Date.now() },
		{ ...page, changedPaths: page.changedPaths });
	if (!merged) return null;
	return commitReadingCache(session, { ...merged, savedAt: Date.now(), revision, deltaBase });
}

/** `onProgress` receives the pages read so far when there is no previous copy to show. */
export async function loadReading(session: ReadingSession, previous?: ReadingCache, onProgress?: (partial: ReadingCache) => void): Promise<ReadingCache> {
	// Without a copy to revalidate, the card index replaces reading every page. An encrypted
	// vault's client reads the index itself.
	if (!previous?.revision && !await prepareReadingEncryption(session, false)) {
		// The index only saves reads: any failure but an expired session lists pages instead.
		let indexed: ReadingCache | null = null;
		try { indexed = await loadReadingFromIndex(session); }
		catch (error) { if (error instanceof ReadingApiError && error.status === 401) throw error; }
		if (indexed) return indexed;
	}
	const cache: ReadingCache = { items: [], issues: [], savedAt: Date.now() }; let cursor: string | null = null;
	const seenCursors = new Set<string>();
	let pages = 0, deltaBase: string | undefined;
	do {
		if (++pages > MAX_READING_LIST_PAGES) throw new Error('Reading library response is too large or unreadable.');
		let response: unknown;
		if (pages === 1) {
			const first = await firstReadingListPage(session, previous);
			if (first.unchanged) return previous!;
			response = first.response;
			if (first.revision) cache.revision = first.revision;
			deltaBase = first.deltaBase;
		} else response = await readingRequest<unknown>(`/reading/list?cursor=${encodeURIComponent(cursor!)}`, session);
		const page = parseReadingListPage(response, readingNoteFolder(session));
		if (!page) throw new Error('Reading library response is unreadable.');
		if (page.changedPaths) {
			const merged = previous && mergeReadingDelta(previous, { ...page, changedPaths: page.changedPaths });
			// Read everything again rather than keep a copy the delta cannot explain.
			if (!merged) return loadReading(session, previous && { ...previous, revision: undefined, deltaBase: undefined }, onProgress);
			return commitReadingCache(session, { ...cache, ...merged, ...(deltaBase ? { deltaBase } : {}) });
		}
		if (cache.items.length + page.items.length > MAX_READING_LIST_ITEMS
			|| cache.issues.length + page.issues.length > MAX_READING_LIST_ISSUES) throw new Error('Reading library response is too large or unreadable.');
		if (page.cursor !== null && seenCursors.has(page.cursor)) throw new Error('Reading library did not advance.');
		if (page.cursor !== null) seenCursors.add(page.cursor);
		cache.items.push(...page.items); cache.issues.push(...page.issues);
		if (page.omitted) cache.omitted = page.omitted;
		cursor = page.cursor;
		if (cursor && !previous && onProgress) onProgress({ ...cache, items: [...cache.items], issues: [...cache.issues] });
	} while (cursor);
	// Pages are already validated; only identities can conflict across pages.
	if (new Set(cache.items.map(item => item.crate_reading_id)).size !== cache.items.length) throw new Error('Reading library response is unreadable.');
	return commitReadingCache(session, { ...cache, ...(deltaBase ? { deltaBase } : {}) });
}

/** A confirmed edit and the library revisions the server reported around it. `article`
 * is the committed item that the server returns with an update. */
export interface ReadingWrite { itemId: string; library?: unknown; article?: unknown; deleted?: true }

// Saved copies of edited items refresh a few at a time.
const ITEM_RELOAD_CONCURRENCY = 3;

/** The committed item from an update response, or null when the server sent none. */
function committedArticle(value: unknown, folder: string, id: string): { item: ReadingItem; etag?: string; markdownHash?: string } | null {
	if (!value || typeof value !== 'object') return null;
	const { item, etag, markdownHash } = value as { item?: unknown; etag?: unknown; markdownHash?: unknown };
	if (!isReadingItem(item, folder) || item.crate_reading_id !== id || !item.path) return null;
	return { item, ...(typeof etag === 'string' && etag.length <= MAX_REVISION_LENGTH ? { etag } : {}), ...(isSha256Hex(markdownHash) ? { markdownHash } : {}) };
}

/** Moves an offline copy to the committed revision when its body is unchanged, so an open
 * reader shows it without downloading the article again. */
async function refreshSavedArticle(session: ReadingSession, item: ReadingItem, etag: string, markdownHash: string): Promise<void> {
	try {
		const saved = await readReadingArticle(session, item.crate_reading_id);
		if (saved && await sha256Hex(saved.markdown) === markdownHash) await cacheReadingArticle(session, item, saved.markdown, { etag, refresh: true });
	} catch { /* The copy is only a cache; the reader downloads the article instead. */ }
}

/** Edits that chain from the cached library revision only need their committed items; any
 * other write, a lost response or a missing revision or item reloads the whole library. */
export async function reloadReadingAfterWrites(session: ReadingSession, writes: ReadingWrite[]): Promise<ReadingCache> {
	const previous = await readReadingCache(session);
	let revision = previous?.revision;
	for (const { library } of writes) {
		if (!revision || !library || typeof library !== 'object') return loadReading(session, previous);
		const { before, after } = library as { before?: unknown; after?: unknown };
		if (before !== revision || typeof after !== 'string' || after.length > MAX_REVISION_LENGTH) return loadReading(session, previous);
		revision = after;
	}
	if (!previous || !writes.length) return loadReading(session, previous);
	const items = new Map<string, ReadingItem | null>(previous.items.map(item => [item.crate_reading_id, item]));
	const deleted = new Set(writes.flatMap(write => write.deleted ? [write.itemId] : []));
	// The last write to an item returned its committed state.
	const latest = new Map(writes.map(write => [write.itemId, write]));
	const ids = [...latest.keys()];
	if (ids.some(id => !items.has(id))) return loadReading(session, previous);
	const committed = new Map<string, NonNullable<ReturnType<typeof committedArticle>>>();
	for (const id of ids) {
		if (deleted.has(id)) continue;
		const article = committedArticle(latest.get(id)!.article, readingNoteFolder(session), id);
		if (!article) return loadReading(session, previous);
		committed.set(id, article);
	}
	await mapBounded(ids, ITEM_RELOAD_CONCURRENCY, async id => {
		const article = committed.get(id);
		items.set(id, article?.item ?? null);
		if (article?.etag && article.markdownHash) await refreshSavedArticle(session, article.item, article.etag, article.markdownHash);
	});
	return commitReadingCache(session, { ...previous, items: previous.items.flatMap(item => items.get(item.crate_reading_id) ?? []), savedAt: Date.now(), revision });
}

/** `etag` names the server revision of the article; an encrypted vault derives it from the note's file. */
export type LoadedReadingArticle = ReadingArticle & { etag?: string };
/** With the ETag of a saved copy, resolves to null while that copy is current. */
export async function loadReadingArticle(session: ReadingSession, id: string): Promise<LoadedReadingArticle>;
export async function loadReadingArticle(session: ReadingSession, id: string, savedEtag: string | undefined): Promise<LoadedReadingArticle | null>;
export async function loadReadingArticle(session: ReadingSession, id: string, savedEtag?: string): Promise<LoadedReadingArticle | null> {
	const result = await retryAfterEncryptionChange(async refresh => {
		const keys = await prepareReadingEncryption(session, refresh);
		if (keys) {
			const value = await encryptedReadingApi(session, keys).item(id, savedEtag); assertReadingSession(session);
			return value;
		}
		encryptedClient = undefined;
		const response = await rawReadingRequest(`/reading/item?id=${encodeURIComponent(id)}`, session, undefined, savedEtag ? { 'If-None-Match': savedEtag } : {});
		if (response.status === 304 && savedEtag) { assertReadingSession(session); return null; }
		const article = await readingResponseJson(response, session);
		const etag = keptRevision(response.headers.get('ETag'));
		return { article, ...(etag ? { etag } : {}) };
	});
	if (!result) return null;
	const { article } = result;
	if (!isReadingArticle(article, readingNoteFolder(session), id) || !article.item.path) throw new Error('Reading article response is unreadable.');
	return { item: article.item, markdown: article.markdown, ...(result.etag ? { etag: result.etag } : {}) };
}
