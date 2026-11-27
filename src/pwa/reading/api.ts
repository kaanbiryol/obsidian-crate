import { reportExpiredConnection, SESSION_RECOVERY_MESSAGE } from '../connection/expiration';
import { onReadingEncryptionReset } from './session/encryption-lifecycle';
import { prepareReadingEncryption, readingEncryptionHeaders, readingNoteFolder } from './session/encryption-session';
import { readReadingAttempt, writeReadingAttempt } from './storage/storage';
import { cacheReadingArticle, readReadingArticle, removeEarlierSessionCopies, type ReadingCache } from './storage/storage';
import { assertReadingSession, type ReadingSession } from './session/session';
import { ReadingApiError } from './session/api-error';
import type { ReadingItem } from '@/reading/core/model';
import { rankReadingTags, type ReadingSection, type ReadingTag } from '@/reading/core/reading-presentation';
import { ENCRYPTED_READING_ACTIONS, EncryptedReadingApi } from '@/pwa/reading/encrypted-api';
import { captureServerArticle } from './capture-article';
import { readingImageType } from '@/reading/core/article-images';
export { ReadingApiError } from './session/api-error';
import { isReadingArticle, isReadingItem, parseReadingChanges, parseReadingListPage, type ReadingArticle, type ReadingChangesAnswer } from './storage/record-validation';
import { applyReadingChanges } from '@/reading/ui/library-changes';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { isSha256Hex } from '@/platform/validation';
import type { FeatureKeys } from '../encryption/encryption-keys';
import { checkEncryptionSignals, retryAfterEncryptionChange } from '../encryption/encryption-retry';
import { responseError } from '../connection/response-error';
import { crateProtocol, crateRequestHeaders, forgetRefusedProtocol } from '../connection/request-headers';
import { rethrowUnreachable } from '../connection/issues';

const ENCRYPTED_READING_PATH = new RegExp(`^/reading/(?:${ENCRYPTED_READING_ACTIONS.join('|')})(?:\\?|$)`);
let encryptedClient: { identity: string; api: EncryptedReadingApi } | undefined;
// The last library read per sign-in, so a refresh asks the server only what changed since.
let lastLibrary: { identity: string; cache: ReadingCache } | undefined;
/** Articles that update responses committed, by item ID, until the open reader takes its own. */
const committedArticles = new Map<string, { identity: string; article: CommittedArticle }>();
const MAX_COMMITTED_ARTICLES = 5;
onReadingEncryptionReset(() => { encryptedClient = undefined; lastLibrary = undefined; committedArticles.clear(); });
const libraryIdentity = (session: ReadingSession) => JSON.stringify([session.token, session.id, session.generation, session.folderPath]);

/** The server answers within 20 seconds; larger bodies also need time to travel. An encrypted
 * capture uploads its images, and an encrypted extract downloads them. */
export function readingRequestTimeout(path: string, body?: string): number {
	const upload = Math.ceil((body?.length ?? 0) / (256 * 1024)) * 1000;
	return 20_000 + upload + (path === '/reading/encrypted-extract' ? 40_000 : 0);
}

async function rawReadingRequest(path: string, session: ReadingSession | null, body?: string, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
	if (session) assertReadingSession(session);
	const method = body === undefined ? 'GET' : 'POST';
	const protocolHeaders = crateRequestHeaders(session?.token, await crateProtocol(path, method));
	if (session) assertReadingSession(session);
	const timeout = AbortSignal.timeout(readingRequestTimeout(path, body));
	const response = await fetch(path, { method, cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		headers: { ...protocolHeaders, ...session ? readingEncryptionHeaders() : {}, 'Content-Type': 'application/json', ...extraHeaders }, body }).catch(rethrowUnreachable);
	if (session) assertReadingSession(session);
	await forgetRefusedProtocol(response);
	if (session && response.status === 401) {
		reportExpiredConnection(session.token);
		throw new ReadingApiError(SESSION_RECOVERY_MESSAGE, 401);
	}
	checkEncryptionSignals(response, path, { probePath: '/reading/encryption', message: 'The encrypted Reading folder changed.' });
	return response;
}
export function readingRequest<T>(path: string, session: ReadingSession | null, body?: string, signal?: AbortSignal): Promise<T> {
	return retryAfterEncryptionChange(refresh => preparedReadingRequest<T>(path, session, body, refresh, signal));
}
/** The encrypted client for this session and key generation. */
function encryptedReadingApi(session: ReadingSession, keys: FeatureKeys): EncryptedReadingApi {
	const identity = JSON.stringify([session.token, session.id, session.generation, session.folderPath, keys.vaultId, keys.generation]);
	if (encryptedClient?.identity !== identity) encryptedClient = { identity, api: new EncryptedReadingApi({
		captureArticle: (url, options) => captureServerArticle(url, body => rawReadingRequest('/reading/encrypted-extract', session, body), options),
		folderPath: keys.folderPath, wireFolder: keys.wireFolder, paths: keys.paths, generation: keys.generation, authority: { vaultId: keys.vaultId, scopeId: 'vault', key: keys.vault },
		searchKey: keys.readingSearch,
		request: (route, wire, headers, signal) => rawReadingRequest(route, session, wire, headers, signal),
		readAttempt: id => readReadingAttempt(session, id),
		writeAttempt: (id, attempt) => writeReadingAttempt(session, id, attempt),
		error: (message, status, code) => new ReadingApiError(message, status, code),
	}) };
	return encryptedClient.api;
}
async function preparedReadingRequest<T>(path: string, session: ReadingSession | null, body?: string, refresh = false, signal?: AbortSignal): Promise<T> {
	if (session) {
		const keys = await prepareReadingEncryption(session, refresh, body !== undefined);
		if (keys && ENCRYPTED_READING_PATH.test(path)) {
			const value = await encryptedReadingApi(session, keys).request(path, body, signal); assertReadingSession(session);
			return value as T;
		}
		if (!keys) encryptedClient = undefined;
	}
	return await readingResponseJson(await rawReadingRequest(path, session, body, {}, signal), session) as T;
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
const MAX_READING_LIST_ISSUES = 10_000;

/** What a library query asks the server for; an encrypted vault's client hashes it. */
export interface ReadingItemsQuery { section: string; q?: string; tag?: string; url?: string; id?: string; cursor?: string }
export interface ReadingItemsPage { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: string | null; revision?: string }

/** One server page of the library, newest first. `signal` cancels it, such as a search typed past. */
export async function queryReadingItems(session: ReadingSession, query: ReadingItemsQuery, signal?: AbortSignal): Promise<ReadingItemsPage> {
	const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
	const page = parseReadingListPage(await readingRequest<unknown>(`/reading/items?${params}`, session, undefined, signal), readingNoteFolder(session));
	if (!page || page.issues.length > MAX_READING_LIST_ISSUES) throw new Error('Reading library response is unreadable.');
	return { items: page.items, issues: page.issues, cursor: page.cursor, ...page.revision ? { revision: page.revision } : {} };
}

/** What changed in the library since `since`, or `reset`. */
async function queryReadingChanges(session: ReadingSession, since: string): Promise<ReadingChangesAnswer> {
	const changes = parseReadingChanges(await readingRequest<unknown>(`/reading/changes?since=${encodeURIComponent(since)}`, session), readingNoteFolder(session));
	if (!changes || !changes.reset && changes.issues.length > MAX_READING_LIST_ISSUES) throw new Error('Reading library response is unreadable.');
	return changes;
}

/** The tags of one section's notes, most used first with their counts. The server breaks ties
 * by term, which an encrypted vault hashes, so they are ranked again here by name. */
export async function queryReadingTags(session: ReadingSession, section: ReadingSection): Promise<ReadingTag[]> {
	const value = await readingRequest<unknown>(`/reading/tags?section=${section}`, session);
	const { tags, counts } = (value ?? {}) as { tags?: unknown; counts?: unknown };
	if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string') || !Array.isArray(counts) || counts.length !== tags.length
		|| !counts.every(count => Number.isSafeInteger(count) && count >= 0)) throw new Error('Reading tags response is unreadable.');
	return rankReadingTags(tags.map((name, index) => ({ name, count: counts[index] as number })));
}

/** The library's first inbox page and its issues, kept in memory. The library stays on the
 * server; sections and searches read their own pages. After the first read, a refresh asks what
 * changed since and applies it: an unchanged library returns the same object, and the changes
 * travel with a new one so the loaded sections apply them too. A confirmed first page also lets
 * earlier sign-ins' offline copies go. */
export async function loadReading(session: ReadingSession): Promise<ReadingCache> {
	const identity = libraryIdentity(session);
	const previous = lastLibrary?.identity === identity ? lastLibrary.cache : undefined;
	if (previous?.revision) {
		const changes = await queryReadingChanges(session, previous.revision);
		if (!changes.reset) {
			if (changes.revision === previous.revision) return previous;
			const delta = { from: previous.revision, to: changes.revision, items: changes.items, removed: changes.removed };
			const changed = new Set([...changes.removed, ...changes.items.map(item => item.path), ...changes.issues.map(issue => issue.path)]);
			const cache: ReadingCache = { items: applyReadingChanges('inbox', previous.items, (previous.cursor ?? null) === null, delta),
				issues: [...previous.issues.filter(issue => !changed.has(issue.path)), ...changes.issues], savedAt: Date.now(), cursor: previous.cursor ?? null,
				revision: changes.revision, changes: delta };
			lastLibrary = { identity, cache };
			return cache;
		}
	}
	const page = await queryReadingItems(session, { section: 'inbox' });
	if (new Set(page.items.map(item => item.crate_reading_id)).size !== page.items.length) throw new Error('Reading library response is unreadable.');
	// Best effort: a failed cleanup must not hide a library the server just returned.
	await removeEarlierSessionCopies(session).catch(() => {});
	const cache: ReadingCache = { items: page.items, issues: page.issues, savedAt: Date.now(), cursor: page.cursor, ...page.revision ? { revision: page.revision } : {} };
	lastLibrary = { identity, cache };
	return cache;
}

/** A confirmed edit. `article`
 * is the committed item that the server returns with an update. */
export interface ReadingWrite { itemId: string; article?: unknown; deleted?: true }

// Saved copies of edited items refresh a few at a time.
const ITEM_RELOAD_CONCURRENCY = 3;

/** The note an update committed. `markdown` is its body when the update rewrote it. */
export interface CommittedArticle { item: ReadingItem; etag: string; markdownHash: string; markdown?: string }

/** The committed item from an update response, or null when the server sent none. */
function committedArticle(value: unknown, folder: string, id: string): { item: ReadingItem; etag?: string; markdownHash?: string; markdown?: string } | null {
	if (!value || typeof value !== 'object') return null;
	const { item, etag, markdownHash, markdown } = value as { item?: unknown; etag?: unknown; markdownHash?: unknown; markdown?: unknown };
	if (!isReadingItem(item, folder) || item.crate_reading_id !== id || !item.path) return null;
	return { item, ...(typeof etag === 'string' && etag.length <= MAX_REVISION_LENGTH ? { etag } : {}), ...(isSha256Hex(markdownHash) ? { markdownHash } : {}),
		...(typeof markdown === 'string' ? { markdown } : {}) };
}

/** Kept for the open reader. A body that does not match its hash is left out, so the reader downloads it. */
async function rememberCommittedArticle(session: ReadingSession, article: CommittedArticle): Promise<void> {
	const { markdown, ...rest } = article;
	const kept = markdown !== undefined && await sha256Hex(markdown) === article.markdownHash ? article : rest;
	committedArticles.delete(article.item.crate_reading_id);
	committedArticles.set(article.item.crate_reading_id, { identity: libraryIdentity(session), article: kept });
	for (const id of committedArticles.keys()) { if (committedArticles.size <= MAX_COMMITTED_ARTICLES) break; committedArticles.delete(id); }
}

/** The article this session's last update to `id` committed, once. */
export function takeCommittedReadingArticle(session: ReadingSession, id: string): CommittedArticle | undefined {
	const committed = committedArticles.get(id);
	committedArticles.delete(id);
	return committed?.identity === libraryIdentity(session) ? committed.article : undefined;
}

/** Moves an offline copy to the committed revision when its body is unchanged, so an open
 * reader shows it without downloading the article again. */
async function refreshSavedArticle(session: ReadingSession, item: ReadingItem, etag: string, markdownHash: string): Promise<void> {
	try {
		const saved = await readReadingArticle(session, item.crate_reading_id);
		if (saved && await sha256Hex(saved.markdown) === markdownHash) await cacheReadingArticle(session, item, saved.markdown, { etag, refresh: true });
	} catch { /* The copy is only a cache; the reader downloads the article instead. */ }
}

/** Saved copies of edited items move to their committed revision, then the first page reloads. */
export async function reloadReadingAfterWrites(session: ReadingSession, writes: ReadingWrite[]): Promise<ReadingCache> {
	const latest = new Map(writes.map(write => [write.itemId, write]));
	await mapBounded([...latest.values()], ITEM_RELOAD_CONCURRENCY, async write => {
		if (write.deleted) return;
		const article = committedArticle(write.article, readingNoteFolder(session), write.itemId);
		if (!article?.etag || !article.markdownHash) return;
		await refreshSavedArticle(session, article.item, article.etag, article.markdownHash);
		await rememberCommittedArticle(session, { ...article, etag: article.etag, markdownHash: article.markdownHash });
	});
	return loadReading(session);
}

/** An image in the Reading folder, as a blob typed by its file name. An encrypted vault's
 * copy is decrypted and checked against its own metadata. */
export async function loadReadingImage(session: ReadingSession, path: string, signal?: AbortSignal): Promise<Blob> {
	const type = readingImageType(path);
	if (!type) throw new Error('This is not an image.');
	const bytes = await retryAfterEncryptionChange(async refresh => {
		const keys = await prepareReadingEncryption(session, refresh);
		if (keys) return encryptedReadingApi(session, keys).image(path, signal);
		const response = await rawReadingRequest(`/reading/file?${new URLSearchParams({ path })}`, session, undefined, {}, signal);
		if (!response.ok) { const failure = await responseError(response, 'Image is unavailable.'); throw new ReadingApiError(failure.message, response.status, failure.code); }
		return new Uint8Array(await response.arrayBuffer());
	});
	assertReadingSession(session);
	return new Blob([bytes], { type });
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
