import type { ReadingItem } from '@/reading/core/model';
import { isRecord } from '@/platform/validation';
import { decodeReadingValue, encodeReadingValue } from './private-storage';
import { readingDatabase, readReadingValue } from './database';
import { abortTransaction } from '../../storage/abort-transaction';
import { assertReadingSession, type ReadingSession } from '../session/session';
import { isReadingArticleCache, isReadingCache, type ReadingArticleCache } from './storage-validation';
import { isArticleReadingKey, readingKeys } from '@/pwa/reading/storage/storage-keys';
import { readingNoteFolder } from '../session/encryption-session';

/** The library's first inbox page and its issues, as last read. The library stays on the
 * server; offline, only saved articles are listed. */
export interface ReadingCache { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number; cursor?: string | null }

export async function readReadingCache(session: ReadingSession): Promise<ReadingCache | undefined> {
	const value = await readReadingValue(readingKeys.list(session.id));
	if (value === undefined) return undefined;
	if (!isReadingCache(value, readingNoteFolder(session))) throw new Error('The saved Reading library could not be read. Refresh when connected.');
	return value;
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
	return [readingKeys.list]
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
	return Array.isArray(value.items);
}

/** Saves the first page and removes earlier sign-ins' offline copies. Saved copies of this
 * session are kept whatever the page lists, since a page is not the whole library. */
export async function commitReadingCache(session: ReadingSession, cache: ReadingCache): Promise<ReadingCache> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite');
	try {
		try { decodeReadingValue(readingKeys.list(session.id), await tx.store.get(readingKeys.list(session.id))); }
		catch {
			// Network results remain usable, but preserve opaque local bytes for export.
			assertReadingSession(session); await tx.done;
			return { ...cache, issues: [...cache.issues, { path: readingNoteFolder(session), message: 'The saved library needs recovery. Export Reading data before clearing this device’s storage.' }] };
		}
		for (const key of await tx.store.getAllKeys()) {
			if (isEarlierCopyKey(key, session.id) && isReadableCopy(key, await tx.store.get(key))) await tx.store.delete(key);
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

/** Items of the articles saved for offline reading, newest first: the library while offline. */
export async function readOfflineReadingItems(session: ReadingSession): Promise<ReadingItem[]> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readonly'), prefix = readingKeys.articlePrefix(session.id), items: ReadingItem[] = [];
	for (const key of await tx.store.getAllKeys()) {
		if (!key.startsWith(prefix)) continue;
		let article: unknown;
		try { article = decodeReadingValue(key, await tx.store.get(key)); } catch { continue; }
		if (isReadingArticleCache(article, readingNoteFolder(session)) && article.offline) items.push(article.item);
	}
	await tx.done; assertReadingSession(session);
	return items.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}

/**
 * Saves an offline copy the user asked for. Copies are never evicted; only the
 * browser's storage quota limits them. `etag` is the server revision the copy came
 * from. `refresh` only replaces an existing saved copy. Resolves to whether the copy
 * is saved.
 */
export async function cacheReadingArticle(session: ReadingSession, item: ReadingItem, markdown: string,
	{ etag, refresh = false }: { etag?: string; refresh?: boolean } = {}): Promise<boolean> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite');
	const key = `${readingKeys.articlePrefix(session.id)}${item.crate_reading_id}`;
	try {
		// Keep a damaged/newer copy exportable even when this article is opened online.
		const previous = await tx.store.get(key);
		const saved = previous === undefined ? undefined : decodeReadingValue(key, previous);
		if (previous !== undefined && !isReadingArticleCache(saved, readingNoteFolder(session))) {
			throw new Error('The saved article needs recovery before replacing its offline copy.');
		}
		const copy = saved as ReadingArticleCache | undefined, replaced = copy?.offline ? copy : undefined;
		if (refresh && !replaced) { await tx.done; return false; }
		const usedAt = replaced?.usedAt ?? Date.now();
		await tx.store.put(encodeReadingValue(key, { item, markdown, usedAt, offline: true, ...etag ? { etag } : {} }), key);
		assertReadingSession(session);
		await tx.done;
	} catch (error) { await abortTransaction(tx); throw error; }
	return true;
}

/** Deletes a saved offline copy. */
export async function removeReadingArticle(session: ReadingSession, id: string): Promise<void> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite');
	try {
		await tx.store.delete(`${readingKeys.articlePrefix(session.id)}${id}`);
		assertReadingSession(session);
		await tx.done;
	} catch (error) { await abortTransaction(tx); throw error; }
}
