import { reportExpiredConnection, SESSION_RECOVERY_MESSAGE } from '../connection/expiration';
import { onReadingEncryptionReset } from './session/encryption-lifecycle';
import { prepareReadingEncryption, readingEncryptionHeaders, readingKeys } from './session/encryption-session';
import { readEncryptedReadingIndex, readReadingAttempt, writeEncryptedReadingIndex, writeReadingAttempt } from './storage/storage';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { AUTH_TOKEN_KEY } from '../config';
import { capturePwaSession } from '../connection/session-generation';
import { cacheReadingArticle, commitReadingCache, readReadingArticle, readReadingCache, type ReadingCache } from './storage/storage';
import { READING_CHANGED_EVENT, READING_SESSION_KEY, assertReadingSession, readingSession, type ReadingSession } from './session/session';
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
import { requestSharedFeaturesRefresh } from '../shared-features';
import { responseError } from '../connection/response-error';

/** Notes carry plaintext paths; an encrypted session names its folder by its tag. */
const noteFolder = (session: ReadingSession) => readingKeys()?.folderPath ?? session.folderPath;

interface SessionAnswer { token: string; sessionCurrent: () => boolean; status: number; ok: boolean; failure: { message: string; code?: string } | null; data: { id?: unknown; folderPath?: unknown; generation?: unknown; expiresAt?: unknown; day?: unknown } | null }
async function requestReadingSession(token: string): Promise<SessionAnswer> {
	const sessionCurrent = capturePwaSession();
	const response = await fetch('/reading/session', { cache: 'no-store', signal: AbortSignal.timeout(20_000),
		headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
	const failure = response.ok ? null : await responseError(response, 'Reading is unavailable.');
	const data = failure ? null : await response.json().catch(() => null) as SessionAnswer['data'];
	return { token, sessionCurrent, status: response.status, ok: response.ok, failure, data };
}

// A session check started while the encryption check runs, for the refresh that follows.
const EARLY_SESSION_MAX_AGE_MS = 10_000;
let earlySession: { token: string; startedAt: number; answer: Promise<SessionAnswer> } | undefined;
/** Starts the next `connectReadingFromReminders` request now. Only its network request
 * runs early; the call that uses the answer applies it, as before. */
export function prefetchReadingSession(): void {
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token) return;
	const entry = { token, startedAt: Date.now(), answer: requestReadingSession(token) };
	earlySession = entry;
	// A failed check is never reused; the next caller asks again.
	entry.answer.then(answer => { if (!answer.ok && earlySession === entry) earlySession = undefined; }, () => { if (earlySession === entry) earlySession = undefined; });
}

/** The Reminders credential's Reading session. `day` is the server's operation day
 * from the same response, so a drain right after it need not ask again. */
export async function connectReadingFromReminders(): Promise<{ session: ReadingSession; day?: number } | null> {
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token) return null;
	const early = earlySession; earlySession = undefined;
	const { sessionCurrent, status, failure, data } = await (early?.token === token && Date.now() - early.startedAt < EARLY_SESSION_MAX_AGE_MS
		? early.answer : requestReadingSession(token));
	if (!sessionCurrent() || localStorage.getItem(AUTH_TOKEN_KEY) !== token) {
		const stored = readingSession();
		return stored && { session: stored };
	}
	if (status === 401) reportExpiredConnection(token);
	if (status === 423) requestSharedFeaturesRefresh(true);
	if (failure) throw new ReadingApiError(failure.message, status, failure.code);
	if (!data || typeof data.id !== 'string' || !data.id || typeof data.folderPath !== 'string' || !data.folderPath
		|| typeof data.generation !== 'string' || !data.generation || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
		throw new Error('The server returned an invalid Reading session.');
	}
	const day = typeof data.day === 'number' && Number.isSafeInteger(data.day) && data.day >= 0 ? data.day : undefined;
	const existing = readingSession();
	if (existing && existing.source !== 'reminders') return { session: existing };
	if (existing?.token === token && existing.generation === data.generation) return { session: existing, day };
	const next: ReadingSession = { token, id: `reminders:${data.id}:${data.generation}`, folderPath: data.folderPath,
		generation: data.generation, expiresAt: data.expiresAt, source: 'reminders' };
	localStorage.setItem(READING_SESSION_KEY, JSON.stringify(next));
	window.dispatchEvent(new Event(READING_CHANGED_EVENT));
	return { session: next, day };
}
const ENCRYPTED_READING_PATH = new RegExp(`^/reading/(?:${ENCRYPTED_READING_ACTIONS.join('|')})(?:\\?|$)`);
let encryptedClient: { identity: string; api: EncryptedReadingApi } | undefined;
onReadingEncryptionReset(() => { encryptedClient = undefined; });
async function rawReadingRequest(path: string, session: ReadingSession | null, body?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
	if (session) assertReadingSession(session);
	const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
		headers: { ...(session ? { Authorization: `Bearer ${session.token}`, ...readingEncryptionHeaders() } : {}), 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), ...extraHeaders }, body });
	if (session) assertReadingSession(session);
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
		request: (route, wire) => rawReadingRequest(route, session, wire),
		readAttempt: id => readReadingAttempt(session, id),
		writeAttempt: (id, attempt) => writeReadingAttempt(session, id, attempt),
		loadIndex: () => readEncryptedReadingIndex(session, indexIdentity, keys.folderPath),
		saveIndex: entries => writeEncryptedReadingIndex(session, indexIdentity, entries),
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
	const response = await rawReadingRequest(path, session, body);
	const failure = response.ok ? null : await responseError(response, 'Reading request failed.');
	const data = failure ? null : await response.json() as T;
	if (session) assertReadingSession(session);
	if (failure) throw new ReadingApiError(failure.message, response.status, failure.code);
	return data as T;
}
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
		return { unchanged: false, response, ...(revision && revision.length <= 128 ? { revision } : {}) };
	}
	const path = previous?.deltaBase ? `/reading/list?since=${encodeURIComponent(previous.deltaBase)}` : '/reading/list';
	let response: Response;
	try { response = await rawReadingRequest(path, session, undefined, previous?.revision ? { 'If-None-Match': previous.revision } : {}); }
	catch (error) { if (error instanceof EncryptionStateChangedError) return unconditional(); throw error; }
	if (response.status === 304 && previous) return { unchanged: true };
	const failure = response.ok ? null : await responseError(response, 'Reading request failed.');
	const data: unknown = failure ? null : await response.json();
	assertReadingSession(session);
	if (failure) throw new ReadingApiError(failure.message, response.status, failure.code);
	const revision = response.headers.get('ETag'), deltaBase = response.headers.get(DELTA_BASE_HEADER);
	return { unchanged: false, response: data, ...(revision && revision.length <= 128 ? { revision } : {}),
		...(deltaBase && deltaBase.length <= 128 ? { deltaBase } : {}) };
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

/** `onProgress` receives the pages read so far when there is no previous copy to show. */
export async function loadReading(session: ReadingSession, previous?: ReadingCache, onProgress?: (partial: ReadingCache) => void): Promise<ReadingCache> {
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
		const page = parseReadingListPage(response, noteFolder(session));
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
		cursor = page.cursor;
		if (cursor && !previous && onProgress) onProgress({ ...cache, items: [...cache.items], issues: [...cache.issues] });
	} while (cursor);
	// Pages are already validated; only identities can conflict across pages.
	if (new Set(cache.items.map(item => item.crate_reading_id)).size !== cache.items.length) throw new Error('Reading library response is unreadable.');
	return commitReadingCache(session, { ...cache, ...(deltaBase ? { deltaBase } : {}) });
}

/** A confirmed edit and the library revisions the server reported around it. `article`
 * is the committed item that a newer server returns with an update. */
export interface ReadingWrite { itemId: string; library?: unknown; article?: unknown; deleted?: true }

// Edited items reload a few at a time.
const ITEM_RELOAD_CONCURRENCY = 3;

/** The committed item from an update response, or null when the server sent none. */
function committedArticle(value: unknown, folder: string, id: string): { item: ReadingItem; etag?: string; markdownHash?: string } | null {
	if (!value || typeof value !== 'object') return null;
	const { item, etag, markdownHash } = value as { item?: unknown; etag?: unknown; markdownHash?: unknown };
	if (!isReadingItem(item, folder) || item.crate_reading_id !== id || !item.path) return null;
	return { item, ...(typeof etag === 'string' && etag.length <= 128 ? { etag } : {}), ...(isSha256Hex(markdownHash) ? { markdownHash } : {}) };
}

/** Moves an offline copy to the committed revision when its body is unchanged, so an open
 * reader shows it without downloading the article again. */
async function refreshSavedArticle(session: ReadingSession, item: ReadingItem, etag: string, markdownHash: string): Promise<void> {
	try {
		const saved = await readReadingArticle(session, item.crate_reading_id);
		if (saved && await sha256Hex(saved.markdown) === markdownHash) await cacheReadingArticle(session, item, saved.markdown, { etag, refresh: true });
	} catch { /* The copy is only a cache; the reader downloads the article instead. */ }
}

/** Edits that chain from the cached library revision only need their items again; any
 * other write, a lost response or a missing revision reloads the whole library. */
export async function reloadReadingAfterWrites(session: ReadingSession, writes: ReadingWrite[]): Promise<ReadingCache> {
	const previous = await readReadingCache(session);
	let revision = previous?.revision;
	for (const { library } of writes) {
		if (!revision || !library || typeof library !== 'object') return loadReading(session, previous);
		const { before, after } = library as { before?: unknown; after?: unknown };
		if (before !== revision || typeof after !== 'string' || after.length > 128) return loadReading(session, previous);
		revision = after;
	}
	if (!previous || !writes.length) return loadReading(session, previous);
	const items = new Map<string, ReadingItem | null>(previous.items.map(item => [item.crate_reading_id, item]));
	const deleted = new Set(writes.flatMap(write => write.deleted ? [write.itemId] : []));
	// The last write to an item returned its committed state; an older server returns none.
	const latest = new Map(writes.map(write => [write.itemId, write]));
	const ids = [...latest.keys()];
	if (ids.some(id => !items.has(id))) return loadReading(session, previous);
	await mapBounded(ids, ITEM_RELOAD_CONCURRENCY, async id => {
		if (deleted.has(id)) { items.set(id, null); return; }
		const committed = committedArticle(latest.get(id)!.article, noteFolder(session), id);
		if (committed) {
			items.set(id, committed.item);
			if (committed.etag && committed.markdownHash) await refreshSavedArticle(session, committed.item, committed.etag, committed.markdownHash);
			return;
		}
		const article = await loadReadingArticle(session, id);
		items.set(id, article.item);
		// Keep an offline copy current, so an open reader does not download the same body again.
		await cacheReadingArticle(session, article.item, article.markdown, { etag: article.etag, refresh: true }).catch(() => false);
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
		const failure = response.ok ? null : await responseError(response, 'Reading request failed.');
		const article: unknown = failure ? null : await response.json();
		assertReadingSession(session);
		if (failure) throw new ReadingApiError(failure.message, response.status, failure.code);
		const etag = response.headers.get('ETag');
		return { article, ...(etag && etag.length <= 128 ? { etag } : {}) };
	});
	if (!result) return null;
	const { article } = result;
	if (!isReadingArticle(article, noteFolder(session), id) || !article.item.path) throw new Error('Reading article response is unreadable.');
	return { item: article.item, markdown: article.markdown, ...(result.etag ? { etag: result.etag } : {}) };
}
