import type { PendingReading } from './outbox';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { readingUrlIdentity, type ReadingItem } from '@/reading/core/model';
import type { ReadingSection } from '@/reading/core/reading-presentation';
import { loadReadingArticle, loadReadingImage, queryReadingItems, takeCommittedReadingArticle, type LoadedReadingArticle } from './api';
import { readReadingArticle, cacheReadingArticle, removeReadingArticle, offlineReadingImagePaths, type OfflineReadingImages, type ReadingCache } from './storage/storage';
import { linkedVaultImages, readingImageType } from '@/reading/core/article-images';
import { arrayBufferToBase64 } from '@/platform/base64';
import { mapBounded } from '@/platform/map-bounded';
import { sha256Hex } from '@/platform/sha256';
import { assertReadingSession, type ReadingSession } from './session/session';
import { presentReadingItems } from './pending-view';
import { dismissReadingArticleHistory, hasReadingArticleHistory, openReadingArticleHistory } from './storage/article-history';

/** `etag` is the server revision of the shown text, kept with an offline copy saved from it. */
interface OpenReadingArticle { item: ReadingItem; markdown: string | null; availableOffline: boolean; etag?: string; error?: string; sourceHighlights?: string; sourceExtractionStatus?: ReadingItem['extraction_status'] }
/** The highlights and extraction state a body was shown for; the reader reloads the body when the item's differ. */
const bodySource = (item: ReadingItem) => ({ sourceHighlights: JSON.stringify(item.highlights ?? []), sourceExtractionStatus: item.extraction_status });
interface ReadingArticleOptions {
	session: ReadingSession | null; cache: ReadingCache | null; pending: PendingReading[];
	isCurrentSession: (session: ReadingSession) => boolean;
	reportSessionError: (session: ReadingSession, error: string | null) => void;
	run: (action: () => Promise<void>) => Promise<void>;
}

/** The vault images an offline copy of `markdown` shows: stored ones are kept and the rest
 * downloaded. One that cannot be downloaded is left out and loads from the server when online. */
async function offlineImages(session: ReadingSession, item: ReadingItem, markdown: string): Promise<OfflineReadingImages> {
	const linked = item.path ? linkedVaultImages(markdown, item.path) : [];
	const stored = linked.length ? await offlineReadingImagePaths(session, item.crate_reading_id) : new Set<string>();
	const save = new Map<string, { type: string; data: string }>();
	await mapBounded(linked.filter(path => !stored.has(path)), 4, async path => {
		try { save.set(path, { type: readingImageType(path)!, data: arrayBufferToBase64(await (await loadReadingImage(session, path)).arrayBuffer()) }); }
		catch { /* Shown from the server when online. */ }
	});
	return { save, keep: new Set(linked) };
}

/** The body this device's own update committed for the open article: the one the response
 * carried, or the shown one when the update left it unchanged. Anything else downloads. */
async function committedBody(session: ReadingSession, reader: OpenReadingArticle, expected: ReturnType<typeof bodySource>): Promise<LoadedReadingArticle | undefined> {
	const committed = takeCommittedReadingArticle(session, reader.item.crate_reading_id), source = committed && bodySource(committed.item);
	if (!committed || source!.sourceHighlights !== expected.sourceHighlights || source!.sourceExtractionStatus !== expected.sourceExtractionStatus) return undefined;
	const markdown = committed.markdown ?? (reader.markdown !== null && await sha256Hex(reader.markdown) === committed.markdownHash ? reader.markdown : undefined);
	return markdown === undefined ? undefined : { item: committed.item, markdown, etag: committed.etag };
}

/** Article navigation and stale-request guards share one lifetime. */
export function useReadingArticle({ session, cache, pending, isCurrentSession, reportSessionError, run }: ReadingArticleOptions) {
	const [reader, setReader] = useState<OpenReadingArticle | null>(null);
	const [readerClosing, setReaderClosing] = useState(false);
	const [readerMotion, setReaderMotion] = useState<'slide' | 'none'>('none');
	const [requestedItem, setRequestedItem] = useState(new URL(location.href).searchParams.get('item'));
	const navigation = useRef(0), appBack = useRef<'closing' | 'traversing' | null>(null), articleStack = useRef<string | null>(null);
	// The navigation whose opening download is in flight; it already fetches the current article.
	const opening = useRef(0);
	useEffect(() => {
		const requests = navigation;
		requests.current++;
		setReader(null); setReaderClosing(false);
		return () => { requests.current++; };
	}, [session]);
	const shown = useRef(reader);
	shown.current = reader;
	useEffect(() => {
		const opened = shown.current;
		if (!cache || !opened?.item.path) return;
		const id = opened.item.crate_reading_id;
		const update = (item: ReadingItem) => setReader(current => current?.item.crate_reading_id === id ? { ...current, item } : current);
		const listed = cache.items.find(item => item.crate_reading_id === id);
		if (listed) { update(listed); return; }
		// The cache holds only the first inbox page, and nothing offline, so a missing item is not
		// deleted. Online, the server is asked for it, so the reader shows confirmed edits and the
		// next edit starts from them instead of conflicting with them.
		if (!session || !navigator.onLine) return;
		const request = navigation.current;
		let active = true;
		queryReadingItems(session, { section: 'all', id }).then(page => {
			const item = page.items.find(item => item.crate_reading_id === id);
			if (active && request === navigation.current && item) update(item);
		}, () => { /* Keep the shown article; the next refresh asks again. */ });
		return () => { active = false; };
	}, [cache, session]);
	const open = useCallback(async (item: ReadingItem, animate = true, section: ReadingSection = 'inbox') => {
		if (!session || appBack.current) return;
		const current = () => isCurrentSession(session)
			&& request === navigation.current && new URL(location.href).searchParams.get('item') === item.crate_reading_id;
		const stack = await openReadingArticleHistory(item.crate_reading_id, section);
		if (!stack) return;
		const request = ++navigation.current;
		if (!current()) return;
		articleStack.current = stack;
		setReaderMotion(animate ? 'slide' : 'none');
		if (!item.path) {
			setReader({ item, markdown: '', availableOffline: false }); reportSessionError(session, null);
			return;
		}
		setReader({ item, markdown: null, availableOffline: false }); reportSessionError(session, null);
		opening.current = request;
		void (async () => {
			let cached = false, saved: Awaited<ReturnType<typeof readReadingArticle>>;
			try {
				saved = await readReadingArticle(session, item.crate_reading_id);
				if (saved?.item?.crate_reading_id === item.crate_reading_id && typeof saved.markdown === 'string') {
					if (current()) { cached = true; setReader({ item, markdown: saved.markdown, availableOffline: true, etag: saved.etag, ...bodySource(saved.item) }); }
				} else saved = undefined;
			} catch { /* A damaged or blocked cache must not prevent an online open. */ }
			if (!current()) return;
			if (!navigator.onLine) {
				if (!cached) setReader({ item, markdown: null, availableOffline: false, error: 'Connect to the internet to open this article. Select More → Save for offline to read it without a connection.' });
				return;
			}
			try {
				// A saved copy of the current revision is kept; only a changed article downloads.
				const article = await loadReadingArticle(session, item.crate_reading_id, cached ? saved?.etag : undefined) ?? saved!;
				if (!current()) return;
				setReader({ item: article.item, markdown: article.markdown, availableOffline: cached, etag: article.etag, ...bodySource(article.item) });
				// Only a copy the user saved is kept, and only when the article changed.
				if (cached && article !== saved) {
					try { await cacheReadingArticle(session, article.item, article.markdown, { etag: article.etag, refresh: true, images: await offlineImages(session, article.item, article.markdown) }); }
					catch { if (current()) reportSessionError(session, 'Offline copy could not be updated.'); }
				}
			} catch (cause) {
				if (!current()) return;
				const message = cause instanceof Error ? cause.message : 'This article could not be opened.';
				if (cached) reportSessionError(session, `Showing saved copy. ${message}`);
				else setReader({ item, markdown: null, availableOffline: false, error: message });
			}
		})().finally(() => { if (opening.current === request) opening.current = 0; });
	}, [session, isCurrentSession, reportSessionError]);
	useEffect(() => {
		// A stale offline copy shown while opening is replaced by that open's own download.
		if (!session || !reader || reader.markdown === null || reader.sourceHighlights === undefined || !navigator.onLine || opening.current === navigation.current
			|| (reader.sourceHighlights === JSON.stringify(reader.item.highlights ?? []) && reader.sourceExtractionStatus === reader.item.extraction_status)) return;
		let active = true;
		const request = navigation.current;
		// Extraction and inline edits can replace the body without changing its saved highlights.
		void (async () => {
			try {
				let saved: Awaited<ReturnType<typeof readReadingArticle>>;
				try { saved = await readReadingArticle(session, reader.item.crate_reading_id); } catch { /* Download the article instead. */ }
				if (!active || request !== navigation.current) return;
				// A saved write already moved the offline copy to this item; it needs no download.
				const expected = bodySource(reader.item), source = saved && bodySource(saved.item);
				if (saved && source!.sourceHighlights === expected.sourceHighlights && source!.sourceExtractionStatus === expected.sourceExtractionStatus) {
					const copy = saved;
					setReader(current => current?.item.crate_reading_id === copy.item.crate_reading_id ? { ...current, markdown: copy.markdown, availableOffline: true, etag: copy.etag, ...expected } : current);
					return;
				}
				const article = await committedBody(session, reader, expected) ?? await loadReadingArticle(session, reader.item.crate_reading_id, saved?.etag) ?? saved!;
				if (!active || request !== navigation.current) return;
				let cached = false, failed = false;
				if (saved) {
					try { cached = await cacheReadingArticle(session, article.item, article.markdown, { etag: article.etag, refresh: true, images: await offlineImages(session, article.item, article.markdown) }); } catch { failed = true; }
				}
				assertReadingSession(session);
				if (!active || request !== navigation.current) return;
				setReader(current => current?.item.crate_reading_id === article.item.crate_reading_id ? { ...current, item: article.item, markdown: article.markdown, availableOffline: cached, etag: article.etag, ...bodySource(article.item) } : current);
				if (failed) reportSessionError(session, 'Offline copy could not be updated.');
			} catch (cause) { if (active) reportSessionError(session, cause instanceof Error ? cause.message : 'Reopen this article to refresh its saved text and highlights.'); }
		})();
		return () => { active = false; };
	}, [reader, session, reportSessionError]);
	useEffect(() => {
		if (!session || !requestedItem || !cache) return;
		const item = presentReadingItems(cache.items, pending).find(item => item.crate_reading_id === requestedItem);
		setRequestedItem(null);
		// An article past the first page is looked up on the server, or offline in its saved copy.
		void run(async () => {
			let found = item;
			if (!found && navigator.onLine) found = (await queryReadingItems(session, { section: 'all', id: requestedItem })).items[0];
			else if (!found) {
				// Offline, the library cache lists nothing; a damaged copy just leaves the library open.
				const saved = await readReadingArticle(session, requestedItem).catch(() => undefined);
				if (saved) found = presentReadingItems([saved.item], pending)[0];
			}
			if (found) await open(found, false);
		});
	}, [cache, pending, session, open, run, requestedItem]);
	useEffect(() => {
		if (!reader || reader.item.path) return;
		const saved = cache?.items.find(item => item.source_url && readingUrlIdentity(item.source_url) === readingUrlIdentity(reader.item.source_url));
		if (saved && (saved.path || saved.crate_reading_id !== reader.item.crate_reading_id)) void open(saved, false);
	}, [cache, reader, open]);
	useEffect(() => {
		let historyFrame = 0;
		const back = () => {
			navigation.current++;
			appBack.current = null;
			// Commit the library before changing history. WebKit can snapshot the current
			// document during pushState; retaining the article here records a stale reader.
			flushSync(() => {
				setReaderMotion('none'); setReader(null); setReaderClosing(false); setRequestedItem(null);
			});
			const stack = articleStack.current; articleStack.current = null;
			cancelAnimationFrame(historyFrame);
			// Let the library paint before WebKit records the replacement history slot.
			historyFrame = requestAnimationFrame(() => {
				historyFrame = requestAnimationFrame(() => dismissReadingArticleHistory(stack));
			});
			setRequestedItem(new URL(location.href).searchParams.get('item'));
		};
		window.addEventListener('popstate', back); return () => { cancelAnimationFrame(historyFrame); window.removeEventListener('popstate', back); };
	}, []);
	const closeReader = () => {
		if (appBack.current || !hasReadingArticleHistory()) return;
		navigation.current++; appBack.current = 'closing';
		// Keep the revealed library inert until the history traversal commits.
		// The outgoing article stays mounted during the slide; input can resume once
		// the library URL commits and the old reader has been removed.
		setReaderClosing(true); setRequestedItem(null); setReaderMotion('slide'); setReader(null);
	};
	const finishReaderClose = useCallback(() => {
		if (appBack.current !== 'closing') return;
		appBack.current = 'traversing'; history.back();
	}, []);
	/** Saves the open article for offline reading, or removes its saved copy. */
	const setOffline = useCallback(async (keep: boolean) => {
		if (!session || !reader?.item.path || reader.markdown === null) return;
		const { item, markdown, etag } = reader;
		if (keep) {
			// Only the browser's storage quota limits saved copies.
			try { await cacheReadingArticle(session, item, markdown, { etag, images: await offlineImages(session, item, markdown) }); }
			catch (error) {
				if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('This device is out of storage. Remove an offline copy to save this one.');
				throw error;
			}
		} else await removeReadingArticle(session, item.crate_reading_id);
		assertReadingSession(session);
		setReader(current => current?.item.crate_reading_id === item.crate_reading_id ? { ...current, availableOffline: keep } : current);
	}, [session, reader]);
	return { reader, readerClosing, readerMotion, open, closeReader, finishReaderClose, setOffline };
}
