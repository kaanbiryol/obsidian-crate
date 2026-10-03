import { encodeReadingValue, decodeReadingValue } from './private-storage';
import type { PendingReading } from './outbox';
import { isPendingReading, isReadingArticleCache, isReadingCache, isReadingDraft, isReadingSession } from './storage-validation';
import { downloadJson } from '../download';
import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { ReadingItem } from '@/reading/core/model';
import { AUTH_TOKEN_KEY } from '../config';
export const READING_SESSION_KEY = 'crate-reading-session-v1';
export interface ReadingSession { token: string; id: string; folderPath: string; generation: string; expiresAt: number; source?: 'reminders' }
export interface ReadingCache { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number }
interface ReadingDatabase extends DBSchema { values: { key: string; value: unknown } }
let opening: Promise<IDBPDatabase<ReadingDatabase>> | undefined;
export function readingDatabase(): Promise<IDBPDatabase<ReadingDatabase>> {
  if (opening) return opening;
  let abandoned = false;
  const request = openDB<ReadingDatabase>('crate-reading-v1', 1, { upgrade(db, _old, _new, tx) {
    if (abandoned) { tx.abort(); return; }
    db.createObjectStore('values');
  }, blocking() { void opening?.then(db => db.close()); opening = undefined; } });
  opening = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { abandoned = true; opening = undefined; reject(new Error('Reading storage is blocked. Close other Crate tabs and retry.')); }, 4000);
    request.then(db => { clearTimeout(timeout); if (abandoned) db.close(); else resolve(db); }, error => { clearTimeout(timeout); opening = undefined; reject(error instanceof Error ? error : new Error('Reading storage is unavailable.')); });
  });
  return opening;
}
export function readingSession(): ReadingSession | null {
  const raw = localStorage.getItem(READING_SESSION_KEY);
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Reading sign-in could not be read. Reconnect from Obsidian settings.'); }
  if (!isReadingSession(value)) throw new Error('Reading sign-in could not be read. Reconnect from Obsidian settings.');
  if (value.source === 'reminders' && localStorage.getItem(AUTH_TOKEN_KEY) !== value.token) return null;
  return value;
}
export function assertReadingSession(session: ReadingSession) {
  const current = readingSession();
  if (current?.id !== session.id || current.token !== session.token || current.generation !== session.generation
    || current.folderPath !== session.folderPath) throw new Error('Reading sign-in changed. Reload this page.');
}
export async function readValue(key: string): Promise<unknown> {
  const db = await readingDatabase();
  const value = decodeReadingValue(key, await db.get('values', key));
  if (value && typeof value === 'object' && 'encryptedShare' in value) {
    const record = value as { encryptedShare: unknown; iv?: unknown; ciphertext?: unknown };
    if (record.encryptedShare !== 1 || !Array.isArray(record.iv) || record.iv.length !== 12 || !Array.isArray(record.ciphertext) || record.ciphertext.length > 32768
      || ![record.iv, record.ciphertext].every((bytes: unknown[]) => bytes.every(byte => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255))) throw new Error('This shared link needs recovery.');
    const secret = await db.get('values', 'share-key') as CryptoKey | undefined;
    if (!secret) throw new Error('This shared link’s device key is unavailable.');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: new TextEncoder().encode(key) }, secret, new Uint8Array(record.ciphertext));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }
  return value;
}

export async function readReadingCache(session: ReadingSession): Promise<ReadingCache | undefined> {
  const value = await readValue(`list:${session.id}`);
  if (value === undefined) return undefined;
  if (!isReadingCache(value, session.folderPath)) throw new Error('The saved Reading library could not be read. Refresh when connected.');
  return value;
}

export async function readReadingDraft(key: string): Promise<{ url: string } | undefined> {
  const value = await readValue(key);
  if (value === undefined) return undefined;
  if (!isReadingDraft(value)) throw new Error('The saved Reading draft could not be read. Export your Reading data before changing browser storage.');
  return value;
}

export async function readReadingArticle(session: ReadingSession, id: string) {
  const value = await readValue(`article:${session.id}:${id}`);
  if (value === undefined) return undefined;
  if (!isReadingArticleCache(value, session.folderPath) || value.item.crate_reading_id !== id) throw new Error('The saved article could not be read. Open it again when connected.');
  return value;
}

export async function hasEarlierReadingChanges(sessionId?: string): Promise<boolean> {
  const db = await readingDatabase();
  for (const key of await db.getAllKeys('values')) {
    if (!key.startsWith('pending:') || key === `pending:${sessionId}`) continue;
    let value: unknown;
    try { value = decodeReadingValue(key, await db.get('values', key)); } catch { return true; }
    if (!Array.isArray(value) || value.length) return true;
  }
  return false;
}
export async function writeValue(key: string, value: unknown, session?: ReadingSession): Promise<void> {
  const db = await readingDatabase();
  if (session) assertReadingSession(session);
  if (value === null) await db.delete('values', key); else await db.put('values', encodeReadingValue(key, value), key);
}
export async function pendingReading(session: ReadingSession): Promise<PendingReading[]> {
  const stored = await readValue(`pending:${session.id}`);
  const data = stored === undefined ? [] : stored;
  const ids = new Set<string>();
  if (!Array.isArray(data) || !data.every((op: unknown): op is PendingReading => {
    if (!isPendingReading(op, session.id) || ids.has(op.id)) return false;
    ids.add(op.id); return true;
  })) throw new Error('Pending Reading changes could not be read. Export your Reading data before changing browser storage.');
  return data;
}
export async function readingLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot safely send Reading changes. Use a current Safari, Chrome, or Firefox.');
  return navigator.locks.request('crate-reading-mutations-v1', action);
}
export async function readingDrainLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot safely send Reading changes. Use a current Safari, Chrome, or Firefox.');
  return navigator.locks.request('crate-reading-drain-v1', action);
}
export async function cacheReadingArticle(session: ReadingSession, item: ReadingItem, markdown: string) {
  const db = await readingDatabase(); assertReadingSession(session);
  const tx = db.transaction('values', 'readwrite');
  const key = `article:${session.id}:${item.crate_reading_id}`;
  try {
    // Keep a damaged/newer copy exportable even when this article is opened online.
    const previous = await tx.store.get(key);
    if (previous !== undefined && !isReadingArticleCache(decodeReadingValue(key, previous), session.folderPath)) {
      throw new Error('The saved article needs recovery before replacing its offline copy.');
    }
    await tx.store.put(encodeReadingValue(key, { item, markdown, usedAt: Date.now() }), key);
    const keys = (await tx.store.getAllKeys()).filter(k => String(k).startsWith(`article:${session.id}:`));
    const records = await Promise.all(keys.map(async key => {
      const raw = await tx.store.get(key);
      try { return { key, value: decodeReadingValue(key, raw) }; }
      catch { return { key, value: undefined }; }
    }));
    // Preserve unreadable copies for recovery; they must not break a healthy write.
    const entries = records.flatMap(entry => isReadingArticleCache(entry.value, session.folderPath) ? [{ key: entry.key, value: entry.value }] : []);
    entries.sort((a, b) => b.value.usedAt - a.value.usedAt);
    let bytes = 0;
    for (let i = 0; i < entries.length; i++) { const entry = entries[i]!; bytes += new TextEncoder().encode(entry.value.markdown).byteLength;
      if (i >= 50 || bytes > 20 * 1024 * 1024) await tx.store.delete(entry.key);
    }
    assertReadingSession(session);
    await tx.done;
  } catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
}
export async function clearReadingData(isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  localStorage.removeItem(READING_SESSION_KEY);
  document.cookie = 'crate-reading-install=; Max-Age=0; Path=/notifications; SameSite=Strict; Secure';
  window.dispatchEvent(new Event('crate-reading-change'));
  // Serialize with in-flight cache writes. Credential checks stop later completions.
  const db = await readingDatabase();
  if (!isCurrent() || localStorage.getItem(READING_SESSION_KEY) !== null) return;
  const tx = db.transaction('values', 'readwrite');
  await tx.store.clear();
  if (!isCurrent() || localStorage.getItem(READING_SESSION_KEY) !== null) { tx.abort(); await tx.done.catch(() => {}); return; }
  await tx.done;
  window.dispatchEvent(new Event('crate-reading-change'));
}
export async function exportReadingData(): Promise<void> {
  const db = await readingDatabase();
  const data: Record<string, unknown> = {}, unreadable: string[] = [];
  for (const key of await db.getAllKeys('values')) {
    if (key === 'share-key' || key === 'share-key-id') continue;
    const raw = await db.get('values', key);
    try { data[key] = await readValue(key); }
    catch { data[key] = raw; unreadable.push(key); }
  }
  // Export healthy records as readable recovery data and preserve opaque damaged
  // records alongside their wrapped local keys. Never silently omit queued work.
  let wrappedKeys: unknown[] = [];
  try { wrappedKeys = await (await import('../encryption-keys')).exportWrappedLocalKeys(); } catch { unreadable.push('encryption-keys'); }
  downloadJson('crate-reading-recovery.json', { format: 2, origin: location.origin, data, wrappedKeys, unreadable });
}

/** Drop ciphertext attempts only after their durable semantic commands settled.
 * The caller holds readingLock, which also serializes edits from other tabs. */
export async function pruneReadingAttempts(session: ReadingSession): Promise<void> {
  const pending = await pendingReading(session);
  const retained = new Set(pending.flatMap(op => {
    if (!op.body) return [];
    try { const body = JSON.parse(op.body) as { operationId?: unknown }; return typeof body.operationId === 'string' ? [body.operationId] : []; } catch { throw new Error('Pending Reading change needs recovery.'); }
  }));
  const db = await readingDatabase(); assertReadingSession(session);
  const prefix = `attempt:${session.id}:`, tx = db.transaction('values', 'readwrite');
  try {
    for (const key of await tx.store.getAllKeys()) if (key.startsWith(prefix) && !retained.has(key.slice(prefix.length))) await tx.store.delete(key);
    assertReadingSession(session); await tx.done;
  } catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
}
