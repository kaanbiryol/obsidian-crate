import type { ReadingItem } from '@/reading/core/model';
import type { EncryptedReadingIndexEntry } from '@/pwa/reading/encrypted-api';
import { isRecord } from '@/platform/validation';
import { decodeReadingValue, encodeReadingValue } from './private-storage';
import { readingDatabase, readReadingValue, writeReadingValue } from './database';
import { abortTransaction } from '../storage/abort-transaction';
import { assertReadingSession, type ReadingSession } from './session';
import { isReadingArticleCache, isReadingCache } from './storage-validation';
import { isReadingItem } from './record-validation';
import { readingKeys } from '@/pwa/reading/storage-keys';
import { readingKeys as readingEncryptionKeys } from './encryption-session';

/** Notes carry plaintext paths; an encrypted session names its folder by its tag. */
const readingFolder = (session: ReadingSession) => readingEncryptionKeys()?.folderPath ?? session.folderPath;

/** `revision` is the server's list ETag for this snapshot, sent back to skip unchanged reloads. */
export interface ReadingCache { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number; revision?: string }

export async function readReadingCache(session: ReadingSession): Promise<ReadingCache | undefined> {
  const value = await readReadingValue(readingKeys.list(session.id));
  if (value === undefined) return undefined;
  if (!isReadingCache(value, readingFolder(session))) throw new Error('The saved Reading library could not be read. Refresh when connected.');
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
      && isReadingItem(entry.item, folder);
  };
}

export async function readReadingArticle(session: ReadingSession, id: string) {
  const value = await readReadingValue(`${readingKeys.articlePrefix(session.id)}${id}`);
  if (value === undefined) return undefined;
  if (!isReadingArticleCache(value, readingFolder(session)) || value.item.crate_reading_id !== id) throw new Error('The saved article could not be read. Open it again when connected.');
  return value;
}

/** Publish a complete library and prune only confirmed deletions in one transaction. */
export async function commitReadingCache(session: ReadingSession, cache: ReadingCache): Promise<ReadingCache> {
  const db = await readingDatabase(); assertReadingSession(session);
  const tx = db.transaction('values', 'readwrite'), prefix = readingKeys.articlePrefix(session.id);
  try {
    const ids = new Set(cache.items.map(item => item.crate_reading_id));
    const uncertain = new Set(cache.issues.map(issue => issue.path));
    const rawPrevious = await tx.store.get(readingKeys.list(session.id));
    let previous: unknown;
    try { previous = decodeReadingValue(readingKeys.list(session.id), rawPrevious); }
    catch {
      // Network results remain usable, but preserve opaque local bytes and avoid
      // pruning articles until the saved inventory can be understood again.
      assertReadingSession(session); await tx.done;
      cache.issues.push({ path: readingFolder(session), message: 'The saved library needs recovery. Export Reading data before clearing this device’s storage.' });
      return cache;
    }
    // Only notes with source issues keep their previous entries.
    if (uncertain.size && isReadingCache(previous, readingFolder(session))) for (const item of previous.items) {
      if (uncertain.has(item.path) && !ids.has(item.crate_reading_id)) {
        cache.items.push(item); ids.add(item.crate_reading_id);
      }
    }
    for (const key of await tx.store.getAllKeys()) if (key.startsWith(prefix) && !ids.has(key.slice(prefix.length))) {
      const raw = await tx.store.get(key);
      let article: unknown;
      try { article = decodeReadingValue(key, raw); } catch { continue; }
      // Unknown records remain exportable; source issues are not deletions.
      if (isReadingArticleCache(article, readingFolder(session)) && !uncertain.has(article.item.path)) await tx.store.delete(key);
    }
    assertReadingSession(session);
    await tx.store.put(encodeReadingValue(readingKeys.list(session.id), cache), readingKeys.list(session.id));
    await tx.done;
  } catch (error) {
    await abortTransaction(tx);
    throw error;
  }
  return cache;
}
/** Background copies carry `prefetched`; their `usedAt` is the article's save time. */
interface ArticleUse { id: string; usedAt: number; bytes: number; prefetched?: true }
const MAX_CACHED_ARTICLES = 200, MAX_CACHED_ARTICLE_BYTES = 50 * 1024 * 1024;
// Articles opened on this device outrank background copies; within each, the newest stays.
const byRetention = (a: ArticleUse, b: ArticleUse) => Number(Boolean(a.prefetched)) - Number(Boolean(b.prefetched)) || b.usedAt - a.usedAt;
const savedRank = (item: ReadingItem) => Date.parse(item.saved_at) || 0;
const backgroundFlag = (prefetched: boolean | undefined) => prefetched ? { prefetched: true as const } : {};

function articleUses(value: unknown): Map<string, ArticleUse> {
  const uses = new Map<string, ArticleUse>();
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) return uses;
  for (const entry of value.entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.usedAt !== 'number' || !Number.isFinite(entry.usedAt)
      || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || (entry.prefetched !== undefined && entry.prefetched !== true)) return new Map();
    uses.set(entry.id, { id: entry.id, usedAt: entry.usedAt, bytes: entry.bytes, ...backgroundFlag(entry.prefetched === true) });
  }
  return uses;
}

/**
 * Saves an offline copy and evicts beyond the caps. A background copy never
 * replaces a saved one or displaces an opened article. Resolves to whether the
 * copy was kept.
 */
export async function cacheReadingArticle(session: ReadingSession, item: ReadingItem, markdown: string, { prefetched = false } = {}): Promise<boolean> {
  const db = await readingDatabase(); assertReadingSession(session);
  const tx = db.transaction('values', 'readwrite');
  const prefix = readingKeys.articlePrefix(session.id), key = `${prefix}${item.crate_reading_id}`, indexKey = readingKeys.articleIndex(session.id);
  let kept: ArticleUse[];
  try {
    // Keep a damaged/newer copy exportable even when this article is opened online.
    const previous = await tx.store.get(key);
    if (previous !== undefined && prefetched) { await tx.done; return true; }
    if (previous !== undefined && !isReadingArticleCache(decodeReadingValue(key, previous), readingFolder(session))) {
      throw new Error('The saved article needs recovery before replacing its offline copy.');
    }
    const usedAt = prefetched ? savedRank(item) : Date.now();
    await tx.store.put(encodeReadingValue(key, { item, markdown, usedAt, ...backgroundFlag(prefetched) }), key);
    // A small use index avoids decrypting every cached article to evict a few.
    let indexed: Map<string, ArticleUse>;
    try { indexed = articleUses(decodeReadingValue(indexKey, await tx.store.get(indexKey))); } catch { indexed = new Map(); }
    const uses: ArticleUse[] = [];
    for (const stored of await tx.store.getAllKeys()) {
      if (!stored.startsWith(prefix)) continue;
      const id = stored.slice(prefix.length);
      if (id === item.crate_reading_id) { uses.push({ id, usedAt, bytes: new TextEncoder().encode(markdown).byteLength, ...backgroundFlag(prefetched) }); continue; }
      const use = indexed.get(id);
      if (use) { uses.push(use); continue; }
      let value: unknown;
      try { value = decodeReadingValue(stored, await tx.store.get(stored)); } catch { continue; }
      // Preserve unreadable copies for recovery; they must not break a healthy write.
      if (isReadingArticleCache(value, readingFolder(session))) uses.push({ id, usedAt: value.usedAt, bytes: new TextEncoder().encode(value.markdown).byteLength, ...backgroundFlag(value.prefetched) });
    }
    uses.sort(byRetention);
    let bytes = 0;
    kept = uses.filter((use, i) => { bytes += use.bytes; return i < MAX_CACHED_ARTICLES && bytes <= MAX_CACHED_ARTICLE_BYTES; });
    for (const use of uses.slice(kept.length)) await tx.store.delete(`${prefix}${use.id}`);
    await tx.store.put(encodeReadingValue(indexKey, { version: 1, entries: kept }), indexKey);
    assertReadingSession(session);
    await tx.done;
  } catch (error) { await abortTransaction(tx); throw error; }
  return kept.some(use => use.id === item.crate_reading_id);
}

/**
 * Inbox articles worth saving in the background, newest first. Opened copies
 * are never displaced, and an article that would rank below the background
 * copies already kept is skipped rather than downloaded only to be evicted.
 */
export async function readingArticlesToPrefetch(session: ReadingSession, items: ReadingItem[], limit: number): Promise<ReadingItem[]> {
  const db = await readingDatabase(); assertReadingSession(session);
  const tx = db.transaction('values', 'readonly');
  const prefix = readingKeys.articlePrefix(session.id), indexKey = readingKeys.articleIndex(session.id);
  const saved = new Set((await tx.store.getAllKeys()).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)));
  let indexed: Map<string, ArticleUse>;
  try { indexed = articleUses(decodeReadingValue(indexKey, await tx.store.get(indexKey))); } catch { indexed = new Map(); }
  await tx.done;
  // Copies missing from the index count as opened, so they are never displaced.
  const background = [...saved].flatMap(id => indexed.get(id)?.prefetched ? [indexed.get(id)!.usedAt] : []);
  const slots = MAX_CACHED_ARTICLES - (saved.size - background.length);
  const candidates = items.filter(item => item.path && item.reading_status === 'inbox' && item.extraction_status === 'ready' && !saved.has(item.crate_reading_id));
  const ranked: Array<{ rank: number; item?: ReadingItem }> = [...background.map(rank => ({ rank })), ...candidates.map(item => ({ rank: savedRank(item), item }))];
  return ranked.sort((a, b) => b.rank - a.rank).slice(0, Math.max(0, slots))
    .flatMap(entry => entry.item ? [entry.item] : []).slice(0, limit);
}
