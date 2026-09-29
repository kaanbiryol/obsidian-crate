import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';
import { validateReadingMetadata } from '@/reading/core/model';
import { AUTH_TOKEN_KEY } from '../config';
import { capturePwaSession } from '../session-generation';
import { READING_SESSION_KEY, assertReadingSession, readingDatabase, readingSession, type ReadingSession, type ReadingCache } from './storage';
import { ReadingApiError } from './api-error';
export { ReadingApiError } from './api-error';
import { isReadingArticleCache, isReadingCache } from './storage-validation';

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
export async function readingRequest<T>(path: string, session: ReadingSession | null, body?: string): Promise<T> {
  if (session) assertReadingSession(session);
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), 'Content-Type': 'application/json', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) }, body });
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
    const previous = await tx.store.get(`list:${session.id}`);
    if (isReadingCache(previous, session.folderPath)) for (const item of previous.items) {
      if (uncertain.has(item.path) && !ids.has(item.crate_reading_id)) {
        cache.items.push(item); ids.add(item.crate_reading_id);
      }
    }
    for (const key of await tx.store.getAllKeys()) if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length))) {
      const article = await tx.store.get(key);
      // Unknown records remain exportable; source issues are not deletions.
      if (isReadingArticleCache(article, session.folderPath) && !uncertain.has(article.item.path)) await tx.store.delete(key);
    }
    assertReadingSession(session);
    await tx.store.put(cache, `list:${session.id}`);
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
    await tx.done.catch(() => {});
    throw error;
  }
  return cache;
}
