import { onReadingEncryptionReset } from './encryption-lifecycle';
import { prepareReadingEncryption, readingEncryptionHeaders } from './encryption-session';
import { EncryptedReadingApi } from '@/reading/encrypted-api';
import { readValue, writeValue } from './storage';
import { encodeReadingValue, decodeReadingValue } from './private-storage';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';
import { validateReadingMetadata } from '@/reading/core/model';
import { AUTH_TOKEN_KEY } from '../config';
import { capturePwaSession } from '../session-generation';
import { READING_SESSION_KEY, assertReadingSession, readingDatabase, readingSession, type ReadingSession, type ReadingCache } from './storage';
import { ReadingApiError } from './api-error';
export { ReadingApiError } from './api-error';
import { isReadingArticleCache, isReadingCache } from './storage-validation';
import { EncryptionScopeChangedError, routeFolderPath } from '../encryption-folder-routing';

export async function connectReadingFromReminders(): Promise<ReadingSession | null> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (!token) return null;
  const sessionCurrent = capturePwaSession();
  const response = await fetch('/reading/session', { cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
  const data = await response.json() as { id?: unknown; folderPath?: unknown; generation?: unknown; expiresAt?: unknown; error?: string; code?: string };
  if (!sessionCurrent() || localStorage.getItem(AUTH_TOKEN_KEY) !== token) return readingSession();
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
async function rawReadingRequest(path: string, session: ReadingSession | null, body?: string): Promise<Response> {
  if (session) assertReadingSession(session);
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { ...(session ? { Authorization: `Bearer ${session.token}`, ...readingEncryptionHeaders() } : {}), 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) }, body });
  if (session) assertReadingSession(session);
  if (response.status === 428 && path !== '/reading/encryption') throw new EncryptionScopeChangedError('The encrypted Reading folder changed.');
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
      if (encryptedClient?.identity !== identity) encryptedClient = { identity, api: new EncryptedReadingApi({
        captureArticle: async url => (await import('./capture-article')).captureBrowserArticle(url),
        folderPath: keys.folderPath, generation: keys.generation, authority: { vaultId: keys.vaultId, scopeId: keys.scopeId, key: keys.data },
        request: (route, wire) => rawReadingRequest(route, session, wire),
        readAttempt: id => readValue(`attempt:${session.id}:${id}`),
        writeAttempt: (id, attempt) => writeValue(`attempt:${session.id}:${id}`, attempt, session),
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
export async function loadReading(session: ReadingSession): Promise<ReadingCache> {
  const cache: ReadingCache = { items: [], issues: [], savedAt: Date.now() }; let cursor: string | null = null;
  do {
    const page: { items: Array<Record<string, unknown>>; issues: ReadingCache['issues']; cursor: string | null } = await readingRequest(`/reading/list${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, session);
    if (!Array.isArray(page.items) || !Array.isArray(page.issues) || cache.items.length > 10_000) throw new Error('Reading library response is too large or unreadable.');
    cache.items.push(...page.items.map(item => ({ ...validateReadingMetadata(item), path: String(item.path) }))); cache.issues.push(...page.issues);
    if (page.cursor && page.cursor === cursor) throw new Error('Reading library did not advance.'); cursor = page.cursor;
  } while (cursor);
  if (!isReadingCache(cache, session.folderPath)) throw new Error('Reading library response is unreadable.');
  const db = await readingDatabase(); assertReadingSession(session);
  const tx = db.transaction('values', 'readwrite'), prefix = `article:${session.id}:`;
  try {
    const ids = new Set(cache.items.map(item => item.crate_reading_id));
    const uncertain = new Set(cache.issues.map(issue => issue.path));
    const rawPrevious = await tx.store.get(`list:${session.id}`);
    let previous: unknown;
    try { previous = decodeReadingValue(`list:${session.id}`, rawPrevious); }
    catch {
      // Network results remain usable, but preserve opaque local bytes and avoid
      // pruning articles until the saved inventory can be understood again.
      assertReadingSession(session); await tx.done;
      cache.issues.push({ path: session.folderPath, message: 'The saved library needs recovery. Export Reading data before clearing this device’s storage.' });
      return cache;
    }
    if (isReadingCache(previous, session.folderPath)) for (const item of previous.items) {
      if (uncertain.has(item.path) && !ids.has(item.crate_reading_id)) {
        cache.items.push(item); ids.add(item.crate_reading_id);
      }
    }
    for (const key of await tx.store.getAllKeys()) if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length))) {
      const raw = await tx.store.get(key);
      let article: unknown;
      try { article = decodeReadingValue(key, raw); } catch { continue; }
      // Unknown records remain exportable; source issues are not deletions.
      if (isReadingArticleCache(article, session.folderPath) && !uncertain.has(article.item.path)) await tx.store.delete(key);
    }
    assertReadingSession(session);
    await tx.store.put(encodeReadingValue(`list:${session.id}`, cache), `list:${session.id}`);
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
    await tx.done.catch(() => {});
    throw error;
  }
  return cache;
}
