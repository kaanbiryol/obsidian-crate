import type { ReadingItem } from '@/reading/core/model';
import { isRecord } from '@/platform/validation';
import { decodeReadingValue, encodeReadingValue } from './private-storage';
import { readingDatabase, readReadingValue } from './database';
import { abortTransaction } from '../../storage/abort-transaction';
import { assertReadingSession, type ReadingSession } from '../session/session';
import { isReadingArticleCache, type ReadingArticleCache } from './storage-validation';
import { isArticleReadingKey, isRetiredReadingCacheKey, readingKeys } from '@/pwa/reading/storage/storage-keys';
import { readingNoteFolder } from '../session/encryption-session';

/** The library's first inbox page and its issues, kept in memory only. The library stays on
 * the server; this device stores only articles saved for offline. */
export interface ReadingCache { items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number; cursor?: string | null }

export async function readReadingArticle(session: ReadingSession, id: string) {
	const value = await readReadingValue(`${readingKeys.articlePrefix(session.id)}${id}`);
	if (value === undefined) return undefined;
	if (!isReadingArticleCache(value, readingNoteFolder(session)) || value.item.crate_reading_id !== id) throw new Error('The saved article could not be read. Open it again when connected.');
	// Copies an earlier version stored without being asked are not offline copies.
	return value.offline ? value : undefined;
}

/** The readable record at `key`, or undefined; unknown or undecodable records stay exportable. */
function readableCopy(key: string, raw: unknown): Record<string, unknown> | undefined {
	// Plaintext copies are checked by shape: once storage is private, decoding refuses them,
	// and an earlier sign-in's plaintext copy must not outlive the switch to encryption.
	let value: unknown = raw;
	if (isRecord(raw) && 'encryptedReading' in raw) {
		try { value = decodeReadingValue(key, raw); } catch { return undefined; }
	}
	return isRecord(value) && isRecord(value.item) && typeof value.markdown === 'string' ? value : undefined;
}

/** Once this session is confirmed, removes the library caches earlier versions stored, readable
 * offline copies an earlier sign-in saved (session IDs change with the token and the folder
 * generation), and this session's copies an earlier version stored without being asked.
 * Queues, drafts and attempts are not copies. */
export async function removeRetiredReadingRecords(session: ReadingSession): Promise<void> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite'), mine = readingKeys.articlePrefix(session.id);
	try {
		for (const key of await tx.store.getAllKeys()) {
			if (isRetiredReadingCacheKey(key)) { await tx.store.delete(key); continue; }
			if (!isArticleReadingKey(key)) continue;
			const copy = readableCopy(key, await tx.store.get(key));
			if (copy && (!key.startsWith(mine) || copy.offline !== true)) await tx.store.delete(key);
		}
		assertReadingSession(session);
		await tx.done;
	} catch (error) {
		await abortTransaction(tx);
		throw error;
	}
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
