import type { ReadingLibraryChanges } from '@/reading/ui/library-changes';
import type { ReadingItem } from '@/reading/core/model';
import { isRecord } from '@/platform/validation';
import { base64ToArrayBuffer } from '@/platform/base64';
import { readingImageType } from '@/reading/core/article-images';
import { decodeReadingValue, encodeReadingValue } from './private-storage';
import { readingDatabase, readReadingValue } from './database';
import { abortTransaction } from '../../storage/abort-transaction';
import { assertReadingSession, type ReadingSession } from '../session/session';
import { isReadingArticleCache, type ReadingArticleCache } from './storage-validation';
import { readingKeyRange, readingKeys } from '@/pwa/reading/storage/storage-keys';
import { isReadingItem } from './record-validation';
import { readingNoteFolder } from '../session/encryption-session';

/** The library's first inbox page and its issues, kept in memory only. The library stays on
 * the server; this device stores only articles saved for offline. */
export interface ReadingCache {
	items: ReadingItem[]; issues: Array<{ path: string; message: string }>; savedAt: number; cursor?: string | null;
	/** The server's library revision these items answer for. */
	revision?: string;
	/** What changed since the previous library, when this one was built from it rather than read again. */
	changes?: ReadingLibraryChanges;
	/** Offline, no library was read; the app lists the articles saved on this device instead. */
	offline?: true;
}

/** An image an offline copy shows: its type and base64 bytes. */
interface OfflineReadingImage { type: string; data: string }
/** The images to store with an offline copy. Stored images outside `keep` are deleted. */
export interface OfflineReadingImages { save: ReadonlyMap<string, OfflineReadingImage>; keep: ReadonlySet<string> }
const imagePrefix = (session: ReadingSession, id: string) => `${readingKeys.articleImagePrefix(session.id)}${id}:`;

/** Vault paths of the images stored with an article's offline copy. */
export async function offlineReadingImagePaths(session: ReadingSession, id: string): Promise<Set<string>> {
	const db = await readingDatabase(); assertReadingSession(session);
	const prefix = imagePrefix(session, id);
	return new Set((await db.getAllKeys('values', readingKeyRange(prefix))).map(key => key.slice(prefix.length)));
}

/** An image stored with an article's offline copy, or undefined when there is none. */
export async function readOfflineReadingImage(session: ReadingSession, id: string, path: string): Promise<Blob | undefined> {
	const value = await readReadingValue(`${imagePrefix(session, id)}${path}`);
	const type = readingImageType(path);
	if (!type || !isRecord(value) || typeof value.data !== 'string' || value.type !== type) return undefined;
	return new Blob([base64ToArrayBuffer(value.data)], { type });
}

export async function readReadingArticle(session: ReadingSession, id: string) {
	const value = await readReadingValue(`${readingKeys.articlePrefix(session.id)}${id}`);
	if (value === undefined) return undefined;
	if (!isReadingArticleCache(value, readingNoteFolder(session)) || value.item.crate_reading_id !== id) throw new Error('The saved article could not be read. Open it again when connected.');
	return value;
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

/** Once this session is confirmed, removes readable offline copies an earlier sign-in saved
 * (session IDs change with the token and the folder generation) and images whose copy is
 * gone. Queues, drafts and attempts are not copies. */
export async function removeEarlierSessionCopies(session: ReadingSession): Promise<void> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite'), mine = readingKeys.articlePrefix(session.id);
	try {
		// `<session>:<id>` of each copy kept, and image and item keys, which go with their copy.
		const copies: string[] = [];
		const images = (await tx.store.getAllKeys(readingKeyRange('article-image:'))).map(key => key.slice('article-image:'.length));
		const items = (await tx.store.getAllKeys(readingKeyRange('article-item:'))).map(key => key.slice('article-item:'.length));
		for (const key of await tx.store.getAllKeys(readingKeyRange('article:'))) {
			// Only earlier sessions' copies can go, so this session's are never read or decrypted.
			if (key.startsWith(mine)) { copies.push(key.slice('article:'.length)); continue; }
			const copy = readableCopy(key, await tx.store.get(key));
			if (copy) await tx.store.delete(key);
			else copies.push(key.slice('article:'.length));
		}
		const kept = new Set(copies);
		// An image belongs to the copy its key starts with, up to one of its colons.
		const hasCopy = (image: string) => {
			for (let end = image.indexOf(':'); end >= 0; end = image.indexOf(':', end + 1)) if (kept.has(image.slice(0, end))) return true;
			return false;
		};
		for (const image of images) if (!hasCopy(image)) await tx.store.delete(`article-image:${image}`);
		for (const item of items) if (!kept.has(item)) await tx.store.delete(`article-item:${item}`);
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
	const rows = readingKeys.articleItemPrefix(session.id), folder = readingNoteFolder(session);
	// Each copy's item is stored apart from its body, so listing never decrypts a body.
	const [copies, keys, values] = await Promise.all([tx.store.getAllKeys(readingKeyRange(prefix)),
		tx.store.getAllKeys(readingKeyRange(rows)), tx.store.getAll(readingKeyRange(rows))]);
	await tx.done; assertReadingSession(session);
	const saved = new Set(copies.map(key => key.slice(prefix.length)));
	keys.forEach((key, index) => {
		const id = key.slice(rows.length);
		if (!saved.has(id)) return;
		let item: unknown;
		try { item = (decodeReadingValue(key, values[index]) as { item?: unknown } | null)?.item; } catch { return; }
		if (isReadingItem(item, folder) && item.crate_reading_id === id) items.push(item);
	});
	return items.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}

/**
 * Saves an offline copy the user asked for. Copies are never evicted; only the
 * browser's storage quota limits them. `etag` is the server revision the copy came
 * from. `refresh` only replaces an existing saved copy. Resolves to whether the copy
 * is saved.
 */
export async function cacheReadingArticle(session: ReadingSession, item: ReadingItem, markdown: string,
	{ etag, refresh = false, images }: { etag?: string; refresh?: boolean; images?: OfflineReadingImages } = {}): Promise<boolean> {
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
		const replaced = saved as ReadingArticleCache | undefined;
		if (refresh && !replaced) { await tx.done; return false; }
		const usedAt = replaced?.usedAt ?? Date.now();
		await tx.store.put(encodeReadingValue(key, { item, markdown, usedAt, ...etag ? { etag } : {} }), key);
		const row = `${readingKeys.articleItemPrefix(session.id)}${item.crate_reading_id}`;
		await tx.store.put(encodeReadingValue(row, { item }), row);
		if (images) {
			const prefix = imagePrefix(session, item.crate_reading_id);
			for (const stored of await tx.store.getAllKeys(readingKeyRange(prefix))) if (!images.keep.has(stored.slice(prefix.length))) await tx.store.delete(stored);
			for (const [path, image] of images.save) await tx.store.put(encodeReadingValue(`${prefix}${path}`, image), `${prefix}${path}`);
		}
		assertReadingSession(session);
		await tx.done;
	} catch (error) { await abortTransaction(tx); throw error; }
	return true;
}

/** Deletes a saved offline copy and its images. */
export async function removeReadingArticle(session: ReadingSession, id: string): Promise<void> {
	const db = await readingDatabase(); assertReadingSession(session);
	const tx = db.transaction('values', 'readwrite');
	try {
		await tx.store.delete(`${readingKeys.articlePrefix(session.id)}${id}`);
		await tx.store.delete(`${readingKeys.articleItemPrefix(session.id)}${id}`);
		await tx.store.delete(readingKeyRange(imagePrefix(session, id)));
		assertReadingSession(session);
		await tx.done;
	} catch (error) { await abortTransaction(tx); throw error; }
}
