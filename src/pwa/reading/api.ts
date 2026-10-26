import { reportExpiredConnection, SESSION_RECOVERY_MESSAGE } from '../connection/expiration';
import { onReadingEncryptionReset } from './session/encryption-lifecycle';
import { prepareReadingEncryption, readingEncryptionHeaders, readingKeys } from './session/encryption-session';
import { readEncryptedReadingIndex, readReadingAttempt, writeEncryptedReadingIndex, writeReadingAttempt } from './storage/storage';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { AUTH_TOKEN_KEY } from '../config';
import { capturePwaSession } from '../connection/session-generation';
import { commitReadingCache, readReadingCache, type ReadingCache } from './storage/storage';
import { READING_CHANGED_EVENT, READING_SESSION_KEY, assertReadingSession, readingSession, type ReadingSession } from './session/session';
import { ReadingApiError } from './session/api-error';
import { EncryptedReadingApi } from '@/pwa/reading/encrypted-api';
import { captureServerArticle } from './capture-article';
export { ReadingApiError } from './session/api-error';
import { isReadingArticle, parseReadingListPage, type ReadingArticle } from './storage/record-validation';
import { checkEncryptionSignals, EncryptionStateChangedError, retryAfterEncryptionChange } from '../encryption/encryption-retry';
import { requestSharedFeaturesRefresh } from '../shared-features';
import { responseError } from '../connection/response-error';

/** Notes carry plaintext paths; an encrypted session names its folder by its tag. */
const noteFolder = (session: ReadingSession) => readingKeys()?.folderPath ?? session.folderPath;

/** The Reminders credential's Reading session. `day` is the server's operation day
 * from the same response, so a drain right after it need not ask again. */
export async function connectReadingFromReminders(): Promise<{ session: ReadingSession; day?: number } | null> {
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token) return null;
	const sessionCurrent = capturePwaSession();
	const response = await fetch('/reading/session', { cache: 'no-store', signal: AbortSignal.timeout(20_000),
		headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
	const failure = response.ok ? null : await responseError(response, 'Reading is unavailable.');
	const data = failure ? null : await response.json().catch(() => null) as { id?: unknown; folderPath?: unknown; generation?: unknown; expiresAt?: unknown; day?: unknown } | null;
	if (!sessionCurrent() || localStorage.getItem(AUTH_TOKEN_KEY) !== token) {
		const stored = readingSession();
		return stored && { session: stored };
	}
	if (response.status === 401) reportExpiredConnection(token);
	if (response.status === 423) requestSharedFeaturesRefresh(true);
	if (failure) throw new ReadingApiError(failure.message, response.status, failure.code);
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
async function preparedReadingRequest<T>(path: string, session: ReadingSession | null, body?: string, refresh = false): Promise<T> {
	if (session) {
		const keys = await prepareReadingEncryption(session, refresh, body !== undefined);
		if (keys && /^\/reading\/(list|item|capture|update|retry)(?:\?|$)/.test(path)) {
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
			const value = await encryptedClient.api.request(path, body); assertReadingSession(session);
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

/** The first plaintext page carries the library ETag. An unchanged library
 * answers 304, so polling does not page through and rewrite every item. */
async function firstReadingListPage(session: ReadingSession, previous?: ReadingCache): Promise<{ unchanged: true } | { unchanged: false; response: unknown; revision?: string }> {
	const unconditional = async () => ({ unchanged: false as const, response: await readingRequest<unknown>('/reading/list', session) });
	if (await prepareReadingEncryption(session)) {
		// The encrypted client answers an unchanged vault from its confirmed inventory.
		const response = await readingRequest<unknown>('/reading/list', session);
		const revision = response && typeof response === 'object' && typeof (response as { revision?: unknown }).revision === 'string'
			? (response as { revision: string }).revision : undefined;
		if (revision && previous && previous.revision === revision) return { unchanged: true };
		return { unchanged: false, response, ...(revision && revision.length <= 128 ? { revision } : {}) };
	}
	let response: Response;
	try { response = await rawReadingRequest('/reading/list', session, undefined, previous?.revision ? { 'If-None-Match': previous.revision } : {}); }
	catch (error) { if (error instanceof EncryptionStateChangedError) return unconditional(); throw error; }
	if (response.status === 304 && previous) return { unchanged: true };
	const failure = response.ok ? null : await responseError(response, 'Reading request failed.');
	const data: unknown = failure ? null : await response.json();
	assertReadingSession(session);
	if (failure) throw new ReadingApiError(failure.message, response.status, failure.code);
	const revision = response.headers.get('ETag');
	return { unchanged: false, response: data, ...(revision && revision.length <= 128 ? { revision } : {}) };
}

export async function loadReading(session: ReadingSession, previous?: ReadingCache): Promise<ReadingCache> {
	const cache: ReadingCache = { items: [], issues: [], savedAt: Date.now() }; let cursor: string | null = null;
	const seenCursors = new Set<string>();
	let pages = 0;
	do {
		if (++pages > MAX_READING_LIST_PAGES) throw new Error('Reading library response is too large or unreadable.');
		let response: unknown;
		if (pages === 1) {
			const first = await firstReadingListPage(session, previous);
			if (first.unchanged) return previous!;
			response = first.response;
			if (first.revision) cache.revision = first.revision;
		} else response = await readingRequest<unknown>(`/reading/list?cursor=${encodeURIComponent(cursor!)}`, session);
		const page = parseReadingListPage(response, noteFolder(session));
		if (!page) throw new Error('Reading library response is unreadable.');
		if (cache.items.length + page.items.length > MAX_READING_LIST_ITEMS
			|| cache.issues.length + page.issues.length > MAX_READING_LIST_ISSUES) throw new Error('Reading library response is too large or unreadable.');
		if (page.cursor !== null && seenCursors.has(page.cursor)) throw new Error('Reading library did not advance.');
		if (page.cursor !== null) seenCursors.add(page.cursor);
		cache.items.push(...page.items); cache.issues.push(...page.issues);
		cursor = page.cursor;
	} while (cursor);
	// Pages are already validated; only identities can conflict across pages.
	if (new Set(cache.items.map(item => item.crate_reading_id)).size !== cache.items.length) throw new Error('Reading library response is unreadable.');
	return commitReadingCache(session, cache);
}

/** A confirmed edit and the library revisions the server reported around it. */
export interface ReadingWrite { itemId: string; library?: unknown }

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
	const items = new Map(previous.items.map(item => [item.crate_reading_id, item]));
	for (const id of new Set(writes.map(write => write.itemId))) {
		if (!items.has(id)) return loadReading(session, previous);
		items.set(id, (await loadReadingArticle(session, id)).item);
	}
	return commitReadingCache(session, { ...previous, items: previous.items.map(item => items.get(item.crate_reading_id)!), savedAt: Date.now(), revision });
}

export async function loadReadingArticle(session: ReadingSession, id: string): Promise<ReadingArticle> {
	const article = await readingRequest<unknown>(`/reading/item?id=${encodeURIComponent(id)}`, session);
	if (!isReadingArticle(article, noteFolder(session), id) || !article.item.path) throw new Error('Reading article response is unreadable.');
	return article;
}
