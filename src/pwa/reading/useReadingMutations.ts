import { useCallback, useEffect, useRef, useState } from 'react';
import { readingUrl, readingUrlIdentity, validateReadingMetadata, type ReadingChanges, type ReadingItem } from '@/reading/core/model';
import { youtubeVideoId } from '@/reading/core/youtube';
import { queueReading, type ReadingCommand } from './outbox';
import { presentReadingItems } from './pending-view';
import { assertReadingSession, writeValue, type ReadingSession } from './storage';
import type { useReadingSession } from './useReadingSession';

type ReadingMutationSession = Pick<ReturnType<typeof useReadingSession>,
  'session' | 'cache' | 'pending' | 'url' | 'share' | 'run' | 'isCurrentSession' |
  'publishPending' | 'reportSessionError' | 'finishCapture'>;
interface ReadingMutationOptions {
  refresh: (session: ReadingSession) => Promise<void>;
  showToast: (kind: 'info' | 'success' | 'error', message: string) => void;
}

/** The mounted runtime owns commands and update guards, independently of its screen. */
export function useReadingMutations(connection: ReadingMutationSession, { refresh, showToast }: ReadingMutationOptions) {
  const { session, cache, pending, url, share, run, isCurrentSession, publishPending, reportSessionError, finishCapture } = connection;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const preparingChanges = useRef(0);
  const [preparationCount, setPreparationCount] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const canApplyUpdate = useCallback(() => preparingChanges.current === 0 && !savingRef.current, []);

  const withPreparation = async <T,>(action: () => Promise<T>): Promise<T> => {
    // Web Locks and IndexedDB can delay durability. Block reload synchronously.
    preparingChanges.current++;
    setPreparationCount(preparingChanges.current);
    try { return await action(); }
    finally {
      preparingChanges.current--;
      if (mounted.current) setPreparationCount(preparingChanges.current);
    }
  };
  const persistChange = async (command: ReadingCommand) => {
    if (!session) throw new Error('Connect Reading before saving changes.');
    try {
      const work = await queueReading(session, command);
      assertReadingSession(session);
      publishPending(session, work);
      return work;
    } catch (cause) {
      if (isCurrentSession(session)) showToast('error', cause instanceof Error ? cause.message : 'Could not save this change on your device.');
      throw cause;
    }
  };
  const queueChange = (command: ReadingCommand) => withPreparation(() => persistChange(command));

  const updateItem = async (item: ReadingItem, changes: ReadingChanges, article?: { item: ReadingItem; markdown: string | null }) => {
    if (!session) return;
    await withPreparation(async () => {
      // Keep the Markdown parser out of app startup while preparing stable legacy
      // highlight metadata before a following annotation queues.
      if (!item.highlight_format && item.highlights?.length && changes.highlights === undefined
        && article?.item.crate_reading_id === item.crate_reading_id && article.markdown !== null
        && !pending.some(op => op.action !== 'capture' && op.intent.id === item.crate_reading_id)) {
        const { writeMarkdownHighlights } = await import('@/reading/core/markdown-highlights');
        changes = { ...changes, highlights: writeMarkdownHighlights(article.markdown, item.highlights).highlights };
      }
      validateReadingMetadata({ ...item, ...changes });
      const before = Object.fromEntries(Object.keys(changes).map(key => [key, item[key as keyof ReadingChanges]]));
      await persistChange({ action: 'update', intent: { id: item.crate_reading_id, changes, before } });
    });
    if (isCurrentSession(session)) void run(() => refresh(session));
  };

  const saveLink = async (openSaved: (item: ReadingItem) => Promise<void>): Promise<boolean> => {
    if (!session || savingRef.current) return false;
    // Input errors stay beside the form; queue failures retain their existing toast.
    const link = readingUrl(url);
    savingRef.current = true; setSaving(true); reportSessionError(session, null);
    try {
      const matches = presentReadingItems(cache?.items ?? [], pending)
        .filter(item => item.source_url && readingUrlIdentity(item.source_url) === readingUrlIdentity(link));
      if (matches.length > 1) throw new Error('Several notes save this link. Review duplicates in Reading.');
      if (matches[0]) {
        await openSaved(matches[0]);
        assertReadingSession(session);
        if (share) await writeValue(`share:${share}`, null, session);
        if (!finishCapture(session)) return false;
        showToast('info', 'Opened your saved link');
        return true;
      }
      await queueChange({ action: 'capture', intent: { url: link, fetchArticle: true } });
      assertReadingSession(session);
      if (share) await writeValue(`share:${share}`, null, session);
      if (!finishCapture(session)) return false;
      showToast('success', navigator.onLine ? 'Link saved' : 'Link saved on this device');
      void run(() => refresh(session));
      return true;
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const retryArticle = async (item: ReadingItem) => {
    if (!session) return;
    await queueChange({ action: 'retry', intent: { id: item.crate_reading_id } });
    if (!isCurrentSession(session)) return;
    showToast('info', youtubeVideoId(item.source_url) ? 'Video details requested.' : 'Article extraction requested.');
    void run(() => refresh(session));
  };

  return { saving, preparingChange: preparationCount > 0, canApplyUpdate, queueChange, saveLink, updateItem, retryArticle };
}
