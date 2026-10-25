import { useCallback, useRef, useState } from 'react';
import { findSavedReadingLink } from '@/reading/core/inventory';
import { readingUrl, validateReadingMetadata, type ReadingChanges, type ReadingItem } from '@/reading/core/model';
import { youtubeVideoId } from '@/reading/core/youtube';
import { queueReading, type ReadingCommand } from './outbox';
import { presentReadingItems } from './pending-view';
import { removeReadingShare } from './storage/storage';
import { assertReadingSession, type ReadingSession } from './session/session';
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
  const canApplyUpdate = useCallback(() => preparingChanges.current === 0 && !savingRef.current, []);

  const withPreparation = async <T,>(action: () => Promise<T>): Promise<T> => {
    // Web Locks and IndexedDB can delay durability. Block reload synchronously.
    preparingChanges.current++;
    setPreparationCount(preparingChanges.current);
    try { return await action(); }
    finally {
      preparingChanges.current--;
      setPreparationCount(preparingChanges.current);
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
      const saved = findSavedReadingLink(presentReadingItems(cache?.items ?? [], pending), link);
      if (saved.kind === 'many') throw new Error('Several notes save this link. Review duplicates in Reading.');
      if (saved.kind === 'one') {
        await openSaved(saved.item);
        assertReadingSession(session);
        if (share) await removeReadingShare(session, share);
        if (!finishCapture(session)) return false;
        showToast('info', 'Opened your saved link');
        return true;
      }
      await queueChange({ action: 'capture', intent: { url: link, fetchArticle: true } });
      assertReadingSession(session);
      if (share) await removeReadingShare(session, share);
      if (!finishCapture(session)) return false;
      showToast('success', navigator.onLine ? 'Link saved' : 'Link saved on this device');
      void run(() => refresh(session));
      return true;
    } finally {
      savingRef.current = false;
      setSaving(false);
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
