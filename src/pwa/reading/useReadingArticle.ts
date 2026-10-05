import type { PendingReading } from './outbox';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { readingUrlIdentity, validateReadingMetadata, type ReadingItem } from '@/reading/core/model';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { readingRequest } from './api';
import { assertReadingSession, readReadingArticle, cacheReadingArticle, type ReadingSession, type ReadingCache } from './storage';
import { presentReadingItems } from './pending-view';
import { dismissReadingArticleHistory, hasReadingArticleHistory, openReadingArticleHistory } from './article-history';

interface OpenReadingArticle { item: ReadingItem; markdown: string | null; availableOffline: boolean; error?: string; sourceHighlights?: string; sourceExtractionStatus?: ReadingItem['extraction_status'] }
interface ReadingArticleOptions {
  session: ReadingSession | null; cache: ReadingCache | null; pending: PendingReading[];
  isCurrentSession: (session: ReadingSession) => boolean;
  reportSessionError: (session: ReadingSession, error: string | null) => void;
  run: (action: () => Promise<void>) => Promise<void>;
}

/** Article navigation and stale-request guards share one lifetime. */
export function useReadingArticle({ session, cache, pending, isCurrentSession, reportSessionError, run }: ReadingArticleOptions) {
  const [reader, setReader] = useState<OpenReadingArticle | null>(null);
  const [readerClosing, setReaderClosing] = useState(false);
  const [readerMotion, setReaderMotion] = useState<'slide' | 'none'>('none');
  const [requestedItem, setRequestedItem] = useState(new URL(location.href).searchParams.get('item'));
  const navigation = useRef(0), appBack = useRef<'closing' | 'traversing' | null>(null), articleStack = useRef<string | null>(null);
  useEffect(() => {
    const requests = navigation;
    requests.current++;
    setReader(null); setReaderClosing(false);
    return () => { requests.current++; };
  }, [session]);
  useEffect(() => {
    if (!cache) return;
    setReader(opened => {
      if (!opened || !opened.item.path) return opened;
      const item = cache.items.find(item => item.crate_reading_id === opened.item.crate_reading_id);
      return item ? { ...opened, item } : null;
    });
  }, [cache]);
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
    void (async () => {
      let cached = false;
      try {
        const saved = await readReadingArticle(session, item.crate_reading_id);
        if (saved?.item?.crate_reading_id === item.crate_reading_id && typeof saved.markdown === 'string') {
          validateReadingMetadata({ ...saved.item });
          if (current()) { cached = true; setReader({ item, markdown: saved.markdown, availableOffline: true, sourceHighlights: JSON.stringify(saved.item.highlights ?? []), sourceExtractionStatus: saved.item.extraction_status }); }
        }
      } catch { /* A damaged or blocked cache must not prevent an online open. */ }
      if (!current()) return;
      if (!navigator.onLine) {
        if (!cached) setReader({ item, markdown: null, availableOffline: false, error: 'Open this article online once to save it here.' });
        return;
      }
      try {
        const article = await readingRequest<{ item: ReadingItem; markdown: string }>(`/reading/item?id=${encodeURIComponent(item.crate_reading_id)}`, session);
        validateReadingMetadata({ ...article.item });
        if (!current()) return;
        setReader({ item: article.item, markdown: article.markdown, availableOffline: cached, sourceHighlights: JSON.stringify(article.item.highlights ?? []), sourceExtractionStatus: article.item.extraction_status });
        try {
          await cacheReadingArticle(session, article.item, article.markdown);
          if (current()) setReader(opened => opened?.item.crate_reading_id === item.crate_reading_id ? { ...opened, availableOffline: true } : opened);
        } catch {
          if (current() && !cached) reportSessionError(session, 'Offline copy could not be saved.');
        }
      } catch (cause) {
        if (!current()) return;
        const message = cause instanceof Error ? cause.message : 'This article could not be opened.';
        if (cached) reportSessionError(session, `Showing saved copy. ${message}`);
        else setReader({ item, markdown: null, availableOffline: false, error: message });
      }
    })();
  }, [session, isCurrentSession, reportSessionError]);
  useEffect(() => {
    if (!session || !reader || reader.markdown === null || reader.sourceHighlights === undefined || !navigator.onLine
      || (reader.sourceHighlights === JSON.stringify(reader.item.highlights ?? []) && reader.sourceExtractionStatus === reader.item.extraction_status)) return;
    let active = true;
    const request = navigation.current;
    // Extraction and inline edits can replace the body without changing its saved highlights.
    void (async () => {
      try {
        const article = await readingRequest<{ item: ReadingItem; markdown: string }>(`/reading/item?id=${encodeURIComponent(reader.item.crate_reading_id)}`, session);
        validateReadingMetadata({ ...article.item });
        if (!active || request !== navigation.current) return;
        let cached = false;
        try { await cacheReadingArticle(session, article.item, article.markdown); cached = true; } catch { /* Preserve the confirmed online article. */ }
        assertReadingSession(session);
        if (!active || request !== navigation.current) return;
        setReader(current => current?.item.crate_reading_id === article.item.crate_reading_id ? { ...current, ...article, availableOffline: cached, sourceHighlights: JSON.stringify(article.item.highlights ?? []), sourceExtractionStatus: article.item.extraction_status } : current);
        if (!cached) reportSessionError(session, 'Offline copy could not be updated.');
      } catch (cause) { if (active) reportSessionError(session, cause instanceof Error ? cause.message : 'Reopen this article to refresh its saved text and highlights.'); }
    })();
    return () => { active = false; };
  }, [reader, session, reportSessionError]);
  useEffect(() => {
    const item = presentReadingItems(cache?.items ?? [], pending).find(item => item.crate_reading_id === requestedItem);
    if (!session || !item) return; setRequestedItem(null);
    void run(() => open(item, false));
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
  return { reader, readerClosing, readerMotion, open, closeReader, finishReaderClose };
}
