import type { ReadingItem } from '@/reading/core/model';
import type { EncryptedReadingIndexEntry } from '@/reading/encrypted-api';
import { isRecord } from '@/platform/validation';
import { decodeReadingValue, encodeReadingValue } from './private-storage';
import { readingDatabase, readReadingValue, writeReadingValue } from './database';
import { assertReadingSession, type ReadingSession } from './session';
import { isReadingArticleCache, isReadingCache } from './storage-validation';
import { isReadingItem } from './record-validation';

/** `revision` is the server's list ETag for this snapshot, sent back to skip unchanged reloads. */
export interface ReadingCache { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number; revision?: string }

export async function readReadingCache(session: ReadingSession): Promise<ReadingCache | undefined> {
  const value = await readReadingValue(`list:${session.id}`);
  if (value === undefined) return undefined;
  if (!isReadingCache(value, session.folderPath)) throw new Error('The saved Reading library could not be read. Refresh when connected.');
  return value;
}

const MAX_INDEX_ENTRIES = 100_000;

/**
 * Authenticated metadata from the last encrypted inventory, bound to its
 * encryption identity. A reload reuses entries whose file is unchanged instead
 * of downloading and decrypting every note again.
 */
export async function readEncryptedReadingIndex(session: ReadingSession, identity: string, folder: string): Promise<EncryptedReadingIndexEntry[] | undefined> {
  const value = await readReadingValue(`encrypted-index:${session.id}`);
  if (!isRecord(value) || value.version !== 1 || value.identity !== identity || !Array.isArray(value.entries) || value.entries.length > MAX_INDEX_ENTRIES) return undefined;
  const entries = value.entries as unknown[];
  return entries.every(isIndexEntry(folder)) ? entries : undefined;
}

export function writeEncryptedReadingIndex(session: ReadingSession, identity: string, entries: EncryptedReadingIndexEntry[]): Promise<void> {
  return writeReadingValue(`encrypted-index:${session.id}`, { version: 1, identity, entries }, session);
}

function isIndexEntry(folder: string) {
  return (entry: unknown): entry is EncryptedReadingIndexEntry => {
    if (!isRecord(entry) || !isRecord(entry.file)) return false;
    const { path, hash, size, revision } = entry.file;
    return typeof path === 'string' && typeof hash === 'string' && typeof revision === 'string'
      && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
      && isReadingItem(entry.item, folder) && entry.item.path === path;
  };
}

export async function readReadingArticle(session: ReadingSession, id: string) {
  const value = await readReadingValue(`article:${session.id}:${id}`);
  if (value === undefined) return undefined;
  if (!isReadingArticleCache(value, session.folderPath) || value.item.crate_reading_id !== id) throw new Error('The saved article could not be read. Open it again when connected.');
  return value;
}

/** Publish a complete library and prune only confirmed deletions in one transaction. */
export async function commitReadingCache(session: ReadingSession, cache: ReadingCache): Promise<ReadingCache> {
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
