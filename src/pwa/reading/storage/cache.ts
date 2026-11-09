import type { ReadingItem } from '@/reading/core/model';
import { MAX_READING_FILES, type EncryptedReadingIndexEntry } from '@/pwa/reading/encrypted-api';
import { isRecord, isSha256Hex } from '@/platform/validation';
import { decodeReadingValue, encodeReadingValue } from './private-storage';
import { readingDatabase, readReadingValue, writeReadingValue } from './database';
import { abortTransaction } from '../../storage/abort-transaction';
import { assertReadingSession, type ReadingSession } from '../session/session';
import { isReadingArticleCache, isReadingCache, type ReadingArticleCache } from './storage-validation';
import { isReadingItem } from './record-validation';
import { isArticleReadingKey, readingKeys } from '@/pwa/reading/storage/storage-keys';
import { readingNoteFolder } from '../session/encryption-session';

/** `revision` is the server's list ETag for this snapshot, sent back to skip unchanged reloads.
 * `deltaBase` is the server's changelog position for it, sent back to receive only changed notes.
 * `omitted` counts older notes an encrypted library left out at this device's limit. */
export interface ReadingCache { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number; revision?: string; deltaBase?: string; omitted?: number }

export async function readReadingCache(session: ReadingSession): Promise<ReadingCache | undefined> {
	const value = await readReadingValue(readingKeys.list(session.id));
	if (value === undefined) return undefined;
	if (!isReadingCache(value, readingNoteFolder(session))) throw new Error('The saved Reading library could not be read. Refresh when connected.');
	return value;
}

/**
 * Authenticated metadata from the last encrypted inventory, bound to its
 * encryption identity. A reload reuses entries whose file is unchanged instead
 * of downloading and decrypting every note again.
 */
export async function readEncryptedReadingIndex(session: ReadingSession, identity: string, folder: string): Promise<EncryptedReadingIndexEntry[] | undefined> {
	const value = await readReadingValue(readingKeys.encryptedIndex(session.id));
	if (!isRecord(value) || value.version !== 1 || value.identity !== identity || !Array.isArray(value.entries) || value.entries.length > MAX_READING_FILES) return undefined;
	const entries = value.entries as unknown[];
	return entries.every(isIndexEntry(folder)) ? entries : undefined;
}

export function writeEncryptedReadingIndex(session: ReadingSession, identity: string, entries: EncryptedReadingIndexEntry[]): Promise<void> {
	return writeReadingValue(readingKeys.encryptedIndex(session.id), { version: 1, identity, entries }, session);
}

function isIndexEntry(folder: string) {
	return (entry: unknown): entry is EncryptedReadingIndexEntry => {
		if (!isRecord(entry) || !isRecord(entry.file)) return false;
		const { path, hash, size, revision } = entry.file;
		return typeof path === 'string' && typeof hash === 'string' && typeof revision === 'string'
			&& typeof size === 'number' && Number.isSafeInteger(size) && size >= 0
			&& isSha256Hex(entry.hash) && isReadingItem(entry.item, folder);
	};
}

export async function readReadingArticle(session: ReadingSession, id: string) {
	const value = await readReadingValue(`${readingKeys.articlePrefix(session.id)}${id}`);
	if (value === undefined) return undefined;
	if (!isReadingArticleCache(value, readingNoteFolder(session)) || value.item.crate_reading_id !== id) throw new Error('The saved article could not be read. Open it again when connected.');
	// Copies an earlier version stored without being asked are not offline copies.
	return value.offline ? value : undefined;
}

/** Offline copies saved under an earlier sign-in; session IDs change with the
 * token and the folder generation. Queues, drafts and attempts are not copies. */
function isEarlierCopyKey(key: string, sessionId: string): boolean {
	if (isArticleReadingKey(key)) return !key.startsWith(readingKeys.articlePrefix(sessionId));
	return [readingKeys.list, readingKeys.articleIndex, readingKeys.encryptedIndex]
		.some(build => key.startsWith(build('')) && key !== build(sessionId));
}

/** A copy this version can read; unknown or undecodable records stay exportable. */
function isReadableCopy(key: string, raw: unknown): boolean {
	// Plaintext copies are checked by shape: once storage is private, decoding refuses them,
	// and an earlier sign-in's plaintext copy must not outlive the switch to encryption.
	let value: unknown = raw;
	if (isRecord(raw) && 'encryptedReading' in raw) {
		try { value = decodeReadingValue(key, raw); } catch { return false; }
	}
	if (!isRecord(value)) return false;
	if (isArticleReadingKey(key)) return isRecord(value.item) && typeof value.markdown === 'string';
	if (key.startsWith(readingKeys.list(''))) return Array.isArray(value.items);
	return (value.version === 1 || value.version === ARTICLE_INDEX_VERSION) && Array.isArray(value.entries);
}

/** Publish a complete library and prune only confirmed deletions in one transaction.
 * The confirmed library also replaces earlier sign-ins' offline copies. */
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
			// The next reload is complete, so this notice cannot outlive the problem.
			delete cache.deltaBase;
			cache.issues.push({ path: readingNoteFolder(session), message: 'The saved library needs recovery. Export Reading data before clearing this device’s storage.' });
			return cache;
		}
		// Only notes with source issues keep their previous entries.
		if (uncertain.size && isReadingCache(previous, readingNoteFolder(session))) for (const item of previous.items) {
			if (uncertain.has(item.path) && !ids.has(item.crate_reading_id)) {
				cache.items.push(item); ids.add(item.crate_reading_id);
			}
		}
		// Saved copies listed in the use index need no decryption unless their note is gone.
		const indexKey = readingKeys.articleIndex(session.id);
		let indexed: Map<string, ArticleUse> | undefined;
		try { indexed = articleUses(decodeReadingValue(indexKey, await tx.store.get(indexKey)), true); } catch { indexed = undefined; }
		const found: ArticleUse[] = [];
		for (const key of await tx.store.getAllKeys()) {
			if (isEarlierCopyKey(key, session.id)) {
				if (isReadableCopy(key, await tx.store.get(key))) await tx.store.delete(key);
				continue;
			}
			if (!key.startsWith(prefix)) continue;
			const id = key.slice(prefix.length);
			if (indexed?.has(id) && ids.has(id)) continue;
			const raw = await tx.store.get(key);
			let article: unknown;
			try { article = decodeReadingValue(key, raw); } catch { continue; }
			if (!isReadingArticleCache(article, readingNoteFolder(session))) continue;
			// Copies an earlier version stored without being asked are removed.
			if (!article.offline) { await tx.store.delete(key); continue; }
			// Unknown records remain exportable; source issues are not deletions.
			if (!ids.has(id) && !uncertain.has(article.item.path)) await tx.store.delete(key);
			else found.push({ id, usedAt: article.usedAt, bytes: new TextEncoder().encode(article.markdown).byteLength });
		}
		// Without a current index every copy was decoded once; record them so later commits skip that.
		if (!indexed) await tx.store.put(encodeReadingValue(indexKey, { version: ARTICLE_INDEX_VERSION, entries: found }), indexKey);
		assertReadingSession(session);
		await tx.store.put(encodeReadingValue(readingKeys.list(session.id), cache), readingKeys.list(session.id));
		await tx.done;
	} catch (error) {
		await abortTransaction(tx);
		throw error;
	}
	return cache;
}
/** The bytes of each saved copy, so a save checks the limits without decrypting every copy.
 * Version 1 also listed copies stored automatically, so it is not trusted. */
interface ArticleUse { id: string; usedAt: number; bytes: number }
const MAX_CACHED_ARTICLES = 200, MAX_CACHED_ARTICLE_BYTES = 50 * 1024 * 1024, ARTICLE_INDEX_VERSION = 2;

function articleUses(value: unknown): Map<string, ArticleUse>;
function articleUses(value: unknown, strict: true): Map<string, ArticleUse> | undefined;
function articleUses(value: unknown, strict = false): Map<string, ArticleUse> | undefined {
	const uses = new Map<string, ArticleUse>();
	if (!isRecord(value) || value.version !== ARTICLE_INDEX_VERSION || !Array.isArray(value.entries)) return strict ? undefined : uses;
	for (const entry of value.entries as unknown[]) {
		if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.usedAt !== 'number' || !Number.isFinite(entry.usedAt)
			|| typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return strict ? undefined : new Map();
		uses.set(entry.id, { id: entry.id, usedAt: entry.usedAt, bytes: entry.bytes });
	}
	return uses;
}

/**
 * Saves an offline copy the user asked for. Copies are never evicted: a save that
 * would pass the limits is refused instead. `etag` is the server revision the copy
 * came from. `refresh` only replaces an existing saved copy. Resolves to whether
 * the copy is saved.
 */
export async function cacheReadingArticle(session: ReadingSession, item: ReadingItem, markdown: string,
	{ etag, refresh = false }: { etag?: string; refresh?: boolean } = {}): Promise<boolean> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite');
	const prefix = readingKeys.articlePrefix(session.id), key = `${prefix}${item.crate_reading_id}`, indexKey = readingKeys.articleIndex(session.id);
	try {
		// Keep a damaged/newer copy exportable even when this article is opened online.
		const previous = await tx.store.get(key);
		const saved = previous === undefined ? undefined : decodeReadingValue(key, previous);
		if (previous !== undefined && !isReadingArticleCache(saved, readingNoteFolder(session))) {
			throw new Error('The saved article needs recovery before replacing its offline copy.');
		}
		const copy = saved as ReadingArticleCache | undefined, replaced = copy?.offline ? copy : undefined;
		if (refresh && !replaced) { await tx.done; return false; }
		const usedAt = replaced?.usedAt ?? Date.now(), bytes = new TextEncoder().encode(markdown).byteLength;
		let indexed: Map<string, ArticleUse>;
		try { indexed = articleUses(decodeReadingValue(indexKey, await tx.store.get(indexKey))); } catch { indexed = new Map(); }
		const uses: ArticleUse[] = [{ id: item.crate_reading_id, usedAt, bytes }];
		for (const stored of await tx.store.getAllKeys()) {
			if (!stored.startsWith(prefix) || stored === key) continue;
			const id = stored.slice(prefix.length), use = indexed.get(id);
			if (use) { uses.push(use); continue; }
			let value: unknown;
			try { value = decodeReadingValue(stored, await tx.store.get(stored)); } catch { continue; }
			// Unreadable copies stay for recovery and do not count.
			if (isReadingArticleCache(value, readingNoteFolder(session)) && value.offline) uses.push({ id, usedAt: value.usedAt, bytes: new TextEncoder().encode(value.markdown).byteLength });
		}
		// A refresh of a saved copy is always kept; a new save must fit.
		if (!replaced && (uses.length > MAX_CACHED_ARTICLES || uses.reduce((sum, use) => sum + use.bytes, 0) > MAX_CACHED_ARTICLE_BYTES)) { await tx.done; return false; }
		await tx.store.put(encodeReadingValue(key, { item, markdown, usedAt, offline: true, ...etag ? { etag } : {} }), key);
		await tx.store.put(encodeReadingValue(indexKey, { version: ARTICLE_INDEX_VERSION, entries: uses }), indexKey);
		assertReadingSession(session);
		await tx.done;
	} catch (error) { await abortTransaction(tx); throw error; }
	return true;
}

/** Deletes a saved offline copy. */
export async function removeReadingArticle(session: ReadingSession, id: string): Promise<void> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite');
	const key = `${readingKeys.articlePrefix(session.id)}${id}`, indexKey = readingKeys.articleIndex(session.id);
	try {
		await tx.store.delete(key);
		let indexed: Map<string, ArticleUse>;
		try { indexed = articleUses(decodeReadingValue(indexKey, await tx.store.get(indexKey))); } catch { indexed = new Map(); }
		if (indexed.delete(id)) await tx.store.put(encodeReadingValue(indexKey, { version: ARTICLE_INDEX_VERSION, entries: [...indexed.values()] }), indexKey);
		assertReadingSession(session);
		await tx.done;
	} catch (error) { await abortTransaction(tx); throw error; }
}
