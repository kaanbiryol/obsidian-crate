import { reportExpiredConnection, SESSION_RECOVERY_MESSAGE } from '../connection/expiration';
import { onReadingEncryptionReset } from './session/encryption-lifecycle';
import { prepareReadingEncryption, readingEncryptionHeaders, readingNoteFolder } from './session/encryption-session';
import { readReadingAttempt, writeReadingAttempt } from './storage/storage';
import { cacheReadingArticle, readReadingArticle, removeEarlierReadingCopies, type ReadingCache } from './storage/storage';
import { assertReadingSession, type ReadingSession } from './session/session';
import { ReadingApiError } from './session/api-error';
import type { ReadingItem } from '@/reading/core/model';
import { ENCRYPTED_READING_ACTIONS, EncryptedReadingApi } from '@/pwa/reading/encrypted-api';
import { captureServerArticle } from './capture-article';
export { ReadingApiError } from './session/api-error';
import { isReadingArticle, isReadingItem, parseReadingListPage, type ReadingArticle } from './storage/record-validation';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { isSha256Hex } from '@/platform/validation';
import type { FeatureKeys } from '../encryption/encryption-keys';
import { checkEncryptionSignals, retryAfterEncryptionChange } from '../encryption/encryption-retry';
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
	if (encryptedClient?.identity !== identity) encryptedClient = { identity, api: new EncryptedReadingApi({
		captureArticle: url => captureServerArticle(url, body => rawReadingRequest('/reading/encrypted-extract', session, body)),
		folderPath: keys.folderPath, wireFolder: keys.wireFolder, paths: keys.paths, generation: keys.generation, authority: { vaultId: keys.vaultId, scopeId: 'vault', key: keys.vault, seal: keys.seal },
		searchKey: keys.readingSearch,
		request: (route, wire, headers) => rawReadingRequest(route, session, wire, headers),
		readAttempt: id => readReadingAttempt(session, id),
		writeAttempt: (id, attempt) => writeReadingAttempt(session, id, attempt),
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
const MAX_READING_LIST_ISSUES = 10_000;

/** What a library query asks the server for; an encrypted vault's client hashes it. */
export interface ReadingItemsQuery { section: string; q?: string; tag?: string; url?: string; id?: string; cursor?: string }
export interface ReadingItemsPage { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; cursor: string | null }

/** One server page of the library, newest first. */
export async function queryReadingItems(session: ReadingSession, query: ReadingItemsQuery): Promise<ReadingItemsPage> {
	const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
	const page = parseReadingListPage(await readingRequest<unknown>(`/reading/items?${params}`, session), readingNoteFolder(session));
	if (!page || page.issues.length > MAX_READING_LIST_ISSUES || page.changedPaths) throw new Error('Reading library response is unreadable.');
	return { items: page.items, issues: page.issues, cursor: page.cursor };
}

/** The library's first inbox page and its issues, kept in memory. The library stays on the
 * server; sections and searches read their own pages. A confirmed page also lets earlier
 * sign-ins' offline copies go. */
export async function loadReading(session: ReadingSession): Promise<ReadingCache> {
	const page = await queryReadingItems(session, { section: 'inbox' });
	if (new Set(page.items.map(item => item.crate_reading_id)).size !== page.items.length) throw new Error('Reading library response is unreadable.');
	await removeEarlierReadingCopies(session);
	return { items: page.items, issues: page.issues, savedAt: Date.now(), cursor: page.cursor };
}

/** A confirmed edit. `article`
 * is the committed item that the server returns with an update. */
export interface ReadingWrite { itemId: string; article?: unknown; deleted?: true }

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

/** Saved copies of edited items move to their committed revision, then the first page reloads. */
export async function reloadReadingAfterWrites(session: ReadingSession, writes: ReadingWrite[]): Promise<ReadingCache> {
	const latest = new Map(writes.map(write => [write.itemId, write]));
	await mapBounded([...latest.values()], ITEM_RELOAD_CONCURRENCY, async write => {
		if (write.deleted) return;
		const article = committedArticle(write.article, readingNoteFolder(session), write.itemId);
		if (article?.etag && article.markdownHash) await refreshSavedArticle(session, article.item, article.etag, article.markdownHash);
	});
	return loadReading(session);
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
