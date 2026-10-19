import { reportExpiredConnection, SESSION_RECOVERY_MESSAGE } from '../connection/expiration';
import { onReadingEncryptionReset } from './encryption-lifecycle';
import { prepareReadingEncryption, readingEncryptionHeaders } from './encryption-session';
import type { EncryptedReadingApi } from '@/pwa/reading/encrypted-api';
import { readEncryptedReadingIndex, readReadingAttempt, writeEncryptedReadingIndex, writeReadingAttempt } from './storage';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { AUTH_TOKEN_KEY } from '../config';
import { capturePwaSession } from '../session-generation';
import { READING_SESSION_KEY, assertReadingSession, commitReadingCache, readingSession, type ReadingSession, type ReadingCache } from './storage';
import { ReadingApiError } from './api-error';
export { ReadingApiError } from './api-error';
import { isReadingArticle, parseReadingListPage, type ReadingArticle } from './record-validation';
import { EncryptionScopeChangedError, routeFolderPath } from '../encryption-folder-routing';
import { requestSharedFeaturesRefresh } from '../shared-features';

export async function connectReadingFromReminders(): Promise<ReadingSession | null> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return null;
  const sessionCurrent = capturePwaSession();
  const response = await fetch('/reading/session', { cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
  const data = await response.json() as { id?: unknown; folderPath?: unknown; generation?: unknown; expiresAt?: unknown; error?: string; code?: string };
  if (!sessionCurrent() || localStorage.getItem(AUTH_TOKEN_KEY) !== token) return readingSession();
  if (response.status === 401) reportExpiredConnection(token);
  if (response.status === 423) requestSharedFeaturesRefresh(true);
  if (!response.ok) throw new ReadingApiError(data.error ?? 'Reading is unavailable.', response.status, data.code);
  if (typeof data.id !== 'string' || !data.id || typeof data.folderPath !== 'string' || !data.folderPath
    || typeof data.generation !== 'string' || !data.generation || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
    throw new Error('Update your Crate server to use Reading with this app.');
  }
  const existing = readingSession();
  if (existing && existing.source !== 'reminders') return existing;
  if (existing?.token === token && existing.generation === data.generation) return existing;
  const next: ReadingSession = { token, id: `reminders:${data.id}:${data.generation}`, folderPath: data.folderPath,
    generation: data.generation, expiresAt: data.expiresAt, source: 'reminders' };
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event('crate-reading-change'));
  return next;
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
  if (response.status === 428 && path !== '/reading/encryption') throw new EncryptionScopeChangedError('The encrypted Reading folder changed.');
  if (response.status === 423) requestSharedFeaturesRefresh(true);
  return response;
}
export async function readingRequest<T>(path: string, session: ReadingSession | null, body?: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await preparedReadingRequest<T>(path, session, body, attempt > 0); }
    catch (error) { if (!(error instanceof EncryptionScopeChangedError) || attempt > 0) throw error; }
  }
}
async function preparedReadingRequest<T>(path: string, session: ReadingSession | null, body?: string, refresh = false): Promise<T> {
  if (session) {
    const keys = await prepareReadingEncryption(session, refresh);
    if (keys && /^\/reading\/(list|item|capture|update|retry)(?:\?|$)/.test(path)) {
      const identity = JSON.stringify([session.token, session.id, session.generation, session.folderPath, keys.vaultId, keys.scopeId, keys.generation]);
      const indexIdentity = JSON.stringify([keys.vaultId, keys.scopeId, keys.generation, keys.folderPath]);
      // Only encrypted vaults need this client; keep it out of the startup bundle.
      const { EncryptedReadingApi } = await import('@/pwa/reading/encrypted-api');
      if (encryptedClient?.identity !== identity) encryptedClient = { identity, api: new EncryptedReadingApi({
        captureArticle: async url => (await import('./capture-article')).captureBrowserArticle(url),
        folderPath: keys.folderPath, generation: keys.generation, authority: { vaultId: keys.vaultId, scopeId: keys.scopeId, key: keys.data },
        request: (route, wire) => rawReadingRequest(route, session, wire),
        readAttempt: id => readReadingAttempt(session, id),
        writeAttempt: (id, attempt) => writeReadingAttempt(session, id, attempt),
        loadIndex: () => readEncryptedReadingIndex(session, indexIdentity, keys.folderPath),
        saveIndex: entries => writeEncryptedReadingIndex(session, indexIdentity, entries),
        error: (message, status, code) => new ReadingApiError(message, status, code),
      }) };
      const value = await encryptedClient.api.request(path, body); assertReadingSession(session);
      // Keep saved articles and requests in their original browser namespace.
      // The encrypted API always authenticates the actual current server path.
      if (value && typeof value === 'object' && keys.folderPath !== session.folderPath) {
        const result = value as { item?: { path: string }; items?: Array<{ path: string }>; issues?: Array<{ path: string }> };
        const local = <V extends { path: string }>(item: V): V => ({ ...item, path: routeFolderPath(item.path, keys.folderPath, session.folderPath) });
        return { ...result, ...(result.item ? { item: local(result.item) } : {}), ...(result.items ? { items: result.items.map(local) } : {}),
          ...(result.issues ? { issues: result.issues.map(local) } : {}) } as T;
      }
      return value as T;
    }
    if (!keys) encryptedClient = undefined;
  }
  const response = await rawReadingRequest(path, session, body);
  const data = await response.json() as T & { error?: string; code?: string };
  if (session) assertReadingSession(session);
  if (!response.ok) throw new ReadingApiError(data.error ?? 'Reading request failed.', response.status, data.code);
  return data;
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
  catch (error) { if (error instanceof EncryptionScopeChangedError) return unconditional(); throw error; }
  if (response.status === 304 && previous) return { unchanged: true };
  const data = await response.json() as { error?: string; code?: string };
  assertReadingSession(session);
  if (!response.ok) throw new ReadingApiError(data.error ?? 'Reading request failed.', response.status, data.code);
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
    const page = parseReadingListPage(response, session.folderPath);
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

export async function loadReadingArticle(session: ReadingSession, id: string): Promise<ReadingArticle> {
  const article = await readingRequest<unknown>(`/reading/item?id=${encodeURIComponent(id)}`, session);
  if (!isReadingArticle(article, session.folderPath, id) || !article.item.path) throw new Error('Reading article response is unreadable.');
  return article;
}
