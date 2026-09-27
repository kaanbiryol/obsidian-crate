import { PwaUpdateButton } from '../components/PwaUpdateNotice';
import { useDocumentReaderScroll } from './useDocumentReaderScroll';
import { highlightReadingCode } from './code-highlighting';
import { PwaToast } from '../components/PwaToast';
import { PwaTabTransition } from '../components/PwaTabTransition';
import { ShortcutSetup } from './ShortcutSetup';
import { manifestHrefForUrl } from '@/cloudflare/worker/pwa/pwa-params';
import { logoutReadingApp } from './logout';
import { PwaDock } from '../components/PwaDock';
import { FeatureSwitcherButton, FeatureNavigationContext } from '../components/FeatureSwitcherButton';
import { PwaPullRefreshIndicator } from '../components/PwaChrome';
import { ReadingOpening } from './ReadingOpening';
import { ReadingSyncIndicator, readingSyncStatus } from './ReadingSyncIndicator';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT, isStandaloneApp } from '../config';
import React, { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ReadingLibraryPanel } from '@/reading/ui/ReadingLibrary';
import { ReadingReader } from '@/reading/ui/Reader';
import { ReadingDialog, ReadingDialogHost } from '@/reading/ui/ReadingDialog';
import { SaveLinkForm } from '@/reading/ui/SaveLinkForm';
import type { ReadingHighlight } from '@/reading/core/highlights';
import { writeMarkdownHighlights } from '@/reading/core/markdown-highlights';
import type { ReadingItem, ReadingChanges } from '@/reading/core/model';
import { readingUrl, readingUrlIdentity, validateReadingMetadata } from '@/reading/core/model';
import { Button } from '@/ui/shared/Button';
import { PwaReadingDialog } from './PwaReadingDialog';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import { SettingsRow } from '../components/SettingsRow';
import { registerPwaServiceWorker } from '../api';
import { useToast } from '../hooks/useToast';
import { useSyncFailureToast } from '../hooks/useSyncFailureToast';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { connectReadingFromReminders, drainReading, loadReading, queueReading, readingRequest } from './api';
import { READING_SESSION_KEY, assertReadingSession, readingLock, readingSession, pendingReading, readValue, writeValue, cacheReadingArticle, exportReadingData,
  readingDatabase, type ReadingSession, type ReadingCache, type PendingReading } from './storage';
import { presentReadingItems } from './pending-view';
import type { ReadingSection } from '@/reading/ui/reading-presentation';
import { dismissReadingArticleHistory, hasReadingArticleHistory, openReadingArticleHistory } from './article-history';

interface OpenReadingArticle { item: ReadingItem; markdown: string | null; availableOffline: boolean; error?: string; sourceHighlights?: string }

export default function ReadingApp() {
  return <ReadingDialogHost.Provider value={PwaReadingDialog}><ReadingAppContent /></ReadingDialogHost.Provider>;
}

function ReadingAppContent() {
  const captureFormId = useId();
  const featureNavigation = useContext(FeatureNavigationContext);
  const active = featureNavigation?.active !== false;
  const { toast, showToast } = useToast();
  const [session, setSession] = useState<ReadingSession | null>(null), [ready, setReady] = useState(false);
  const [cache, setCache] = useState<ReadingCache | null>(null), [pending, setPending] = useState<PendingReading[]>([]);
  const [syncing, setSyncing] = useState(false), [syncedSession, setSyncedSession] = useState<ReadingSession | null>(null);
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine);
  useEffect(() => {
    const changed = () => { setIsOffline(!navigator.onLine); setSyncedSession(null); };
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [reader, setReader] = useState<OpenReadingArticle | null>(null);
  const [focusHighlight, setFocusHighlight] = useState<ReadingHighlight>();
  const [readerMotion, setReaderMotion] = useState<'slide' | 'none'>('none');
  const [phoneReader, setPhoneReader] = useState(() => window.matchMedia('(max-width: 719px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 719px)');
    const changed = () => setPhoneReader(media.matches);
    media.addEventListener('change', changed); return () => media.removeEventListener('change', changed);
  }, []);
  useDocumentReaderScroll(ready && !!session && phoneReader && active && !!reader, reader?.item.crate_reading_id);
  const [adding, setAdding] = useState(false), [url, setUrl] = useState(''), [saving, setSaving] = useState(false);
  const [share, setShare] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useSettingsOpen();
  const [requestedItem, setRequestedItem] = useState(new URL(location.href).searchParams.get('item'));
  const [recovery, setRecovery] = useState(false);
  const [connecting, setConnecting] = useState(false);
  useSyncFailureToast({
    scope: session ? JSON.stringify([session.id, session.token, session.generation]) : null,
    ready,
    operationIds: pending.filter(op => op.sessionId === session?.id && (op.review || op.error && (op.retryAt === undefined || (op.attempts ?? 0) >= 3))).map(op => op.id),
    feature: 'Reading', showToast,
    isCurrent: () => { if (!session) return false; try { assertReadingSession(session); return true; } catch { return false; } },
  });
  const alive = useRef(true), refreshing = useRef(false), refreshQueued = useRef<ReadingSession | null>(null), savingRef = useRef(false), connectingRef = useRef(false);
  const navigation = useRef(0);
  const appBack = useRef<'closing' | 'traversing' | null>(null);
  const articleStack = useRef<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>) => { try { await action(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Reading is unavailable.'); } }, []);
  const connect = useCallback(async () => {
    if (connectingRef.current || !navigator.onLine || !localStorage.getItem(AUTH_TOKEN_KEY)) return;
    connectingRef.current = true; setConnecting(true);
    try {
      const next = await connectReadingFromReminders();
      if (!alive.current || !next) return;
      const saved = await readValue<ReadingCache>(`list:${next.id}`);
      if (saved) saved.items.forEach(item => validateReadingMetadata({ ...item }));
      const work = await pendingReading(next);
      const draft = await readValue<{ url: string }>(`draft:${next.id}`);
      const db = await readingDatabase();
      let hasEarlierChanges = false;
      for (const key of (await db.getAllKeys('values')).filter(key => key.startsWith('pending:') && key !== `pending:${next.id}`)) {
        const value = await db.get('values', key); if (!Array.isArray(value) || value.length) { hasEarlierChanges = true; break; }
      }
      if (!alive.current || readingSession()?.id !== next.id) return;
      setCache(saved ?? null); setPending(work); setRecovery(hasEarlierChanges);
      if (draft?.url) { setUrl(draft.url); setAdding(true); }
      setSession(next); setError(null);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Reading is unavailable.'); }
    finally { connectingRef.current = false; if (alive.current) setConnecting(false); }
  }, []);
  const refresh = useCallback(async (current = session) => {
    if (!current) return;
    if (refreshing.current) { refreshQueued.current = current; return; }
    refreshing.current = true; setSyncing(true); setSyncedSession(null);
    try {
      let data: ReadingCache | undefined;
      let completed = false;
      try {
        const confirmed = await drainReading(current);
        data = navigator.onLine ? confirmed ?? await loadReading(current) : await readValue<ReadingCache>(`list:${current.id}`);
        completed = true;
      } finally {
        // Publish the latest durable queue even when refreshing the list fails.
        // Queue edits and this read share a lock so a stale refresh cannot hide new work.
        await readingLock(async () => {
          const work = await pendingReading(current);
          assertReadingSession(current);
          if (!alive.current) return;
          if (data) {
            setCache(data);
            const items = data.items;
            setReader(opened => {
              if (!opened || !opened.item.path) return opened;
              const item = items.find(item => item.crate_reading_id === opened.item.crate_reading_id);
              return item ? { ...opened, item } : null;
            });
          }
          setPending(work);
          if (completed) setError(null);
          if (completed && navigator.onLine && data) setSyncedSession(current);
        });
      }
    } finally {
      refreshing.current = false;
      if (alive.current) setSyncing(false);
      const queued = refreshQueued.current;
      refreshQueued.current = null;
      if (queued && alive.current) {
        const latest = readingSession();
        if (latest?.id === queued.id && latest.token === queued.token && latest.generation === queued.generation) void run(() => refresh(queued));
      }
    }
  }, [session, run]);
  const retryAt = Math.min(...pending.filter(op => op.error && !op.review && (op.attempts ?? 0) < 3 && op.retryAt !== undefined).map(op => op.retryAt!));
  useEffect(() => {
    if (!session || !ready || isOffline || !Number.isFinite(retryAt)) return;
    // Match Reminders' short, bounded retries for interrupted requests. Their
    // exact persisted bodies remain authoritative until a receipt is confirmed.
    // Subscribe to the deadline, not queue object identity: a failed session/list
    // read must not repeatedly reschedule an already elapsed retry.
    const timer = window.setTimeout(() => { void run(() => refresh(session)); }, Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session, ready, isOffline, retryAt, refresh, run]);
  useEffect(() => {
    alive.current = true;
    void run(async () => {
      try {
        const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]'); if (manifest) manifest.href = manifestHrefForUrl(location.href);
        const fragment = new URLSearchParams(location.hash.slice(1)); const installed = isStandaloneApp();
        const installGrant = installed && !readingSession() ? document.cookie.split('; ').find(c => c.startsWith('crate-reading-install='))?.split('=')[1] : null;
        const grant = fragment.get('reading') || installGrant;
        if (grant) {
          history.replaceState(null, '', '/notifications?section=reading');
          const { installToken, ...next } = await readingRequest<ReadingSession & { installToken?: string }>('/reading/exchange', null, JSON.stringify({ token: grant }));
          localStorage.setItem(READING_SESSION_KEY, JSON.stringify(next));
          document.cookie = 'crate-reading-install=; Max-Age=0; Path=/notifications; SameSite=Strict; Secure';
          if (!installed && installToken) {
            document.cookie = `crate-reading-install=${installToken}; Max-Age=600; Path=/notifications; SameSite=Strict; Secure`;
          }
        }
        const current = readingSession(); setSession(current);
        const db = await readingDatabase();
        const keys = await db.getAllKeys('values');
        for (const key of keys.filter(key => key.startsWith('pending:') && key !== `pending:${current?.id}`)) {
          const value = await db.get('values', key); if (!Array.isArray(value) || value.length) setRecovery(true);
        }
        if (current) {
          const saved = await readValue<ReadingCache>(`list:${current.id}`);
          if (saved) { saved.items.forEach(item => validateReadingMetadata({ ...item })); setCache(saved); }
          setPending(await pendingReading(current));
          const draft = await readValue<{ url: string }>(`draft:${current.id}`);
          if (draft?.url) { setUrl(draft.url); setAdding(true); }
        }
        const shareId = new URL(location.href).searchParams.get('share');
        if (shareId) { const draft = await readValue<{ url: string }>(`share:${shareId}`);
          if (draft) { setUrl(draft.url); setAdding(true); setShare(shareId); }
        }
        await registerPwaServiceWorker(); navigator.serviceWorker?.controller?.postMessage({ type: 'CRATE_CLIENT_VERSION', version: PWA_ASSET_VERSION });
      } finally { if (alive.current) setReady(true); }
    });
    return () => { alive.current = false; };
  }, [run]);
  useEffect(() => {
    if (!ready || session) return;
    const changed = (event: StorageEvent) => { if (event.key === AUTH_TOKEN_KEY || event.key === READING_SESSION_KEY || event.key === null) void connect(); };
    const retry = () => { void connect(); };
    const resume = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', retry);
    window.addEventListener('pageshow', retry);
    window.addEventListener('storage', changed);
    window.addEventListener(PWA_AUTH_CHANGED_EVENT, retry);
    document.addEventListener('visibilitychange', resume);
    retry();
    return () => { window.removeEventListener('online', retry); window.removeEventListener('pageshow', retry); window.removeEventListener('storage', changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, retry); document.removeEventListener('visibilitychange', resume); };
  }, [ready, session, connect]);
  useEffect(() => {
    if (!session || !ready) return;
    const reload = () => { if (document.visibilityState === 'visible') void run(async () => {
      if (session.source === 'reminders' && navigator.onLine) {
        const current = await connectReadingFromReminders();
        if (!current || current.id !== session.id || current.generation !== session.generation) {
          navigation.current++; setSettingsOpen(false); setSession(null); setCache(null); setReader(null); setPending([]); return;
        }
      }
      await refresh(session);
    }); };
    const changed = () => { const current = readingSession(); if (current?.id !== session.id || current.generation !== session.generation || current.token !== session.token) { navigation.current++; setSettingsOpen(false); setSession(null); setCache(null); setReader(null); setPending([]); if (!share) { setUrl(''); setAdding(false); } } else reload(); };
    reload();
    const timer = window.setInterval(reload, 30_000);
    window.addEventListener('online', reload); window.addEventListener('storage', changed); window.addEventListener('crate-reading-change', changed); window.addEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.addEventListener('visibilitychange', reload);
    return () => { clearInterval(timer); window.removeEventListener('online', reload); window.removeEventListener('storage', changed); window.removeEventListener('crate-reading-change', changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.removeEventListener('visibilitychange', reload); };
  }, [session, ready, refresh, run, share, setSettingsOpen]);
  useEffect(() => { if (session && ready) void run(() => writeValue(`draft:${session.id}`, { url }, session)); }, [session, ready, url, run]);
  const open = useCallback(async (item: ReadingItem, animate = true, section: ReadingSection = 'inbox') => {
    if (!session || appBack.current) return;
    const current = () => alive.current && readingSession()?.id === session.id && readingSession()?.token === session.token
      && request === navigation.current && new URL(location.href).searchParams.get('item') === item.crate_reading_id;
    const stack = await openReadingArticleHistory(item.crate_reading_id, section);
    if (!stack) return;
    const request = ++navigation.current;
    if (!current()) return;
    articleStack.current = stack;
    setReaderMotion(animate ? 'slide' : 'none');
    if (!item.path) {
      setReader({ item, markdown: '', availableOffline: false }); setError(null);
      return;
    }
    setReader({ item, markdown: null, availableOffline: false }); setError(null);
    void (async () => {
      let cached = false;
      try {
        const saved = await readValue<{ item: ReadingItem; markdown: string }>(`article:${session.id}:${item.crate_reading_id}`);
        if (saved?.item?.crate_reading_id === item.crate_reading_id && typeof saved.markdown === 'string') {
          validateReadingMetadata({ ...saved.item });
          if (current()) { cached = true; setReader({ item, markdown: saved.markdown, availableOffline: true, sourceHighlights: JSON.stringify(item.highlights ?? []) }); }
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
        setReader({ item: article.item, markdown: article.markdown, availableOffline: cached, sourceHighlights: JSON.stringify(article.item.highlights ?? []) });
        try {
          await cacheReadingArticle(session, article.item, article.markdown);
          if (current()) setReader(opened => opened?.item.crate_reading_id === item.crate_reading_id ? { ...opened, availableOffline: true } : opened);
        } catch {
          if (current() && !cached) setError('Offline copy could not be saved.');
        }
      } catch (cause) {
        if (!current()) return;
        const message = cause instanceof Error ? cause.message : 'This article could not be opened.';
        if (cached) setError(`Showing saved copy. ${message}`);
        else setReader({ item, markdown: null, availableOffline: false, error: message });
      }
    })();
  }, [session]);
  useEffect(() => {
    if (!session || !reader || reader.markdown === null || reader.sourceHighlights === undefined || !navigator.onLine
      || reader.sourceHighlights === JSON.stringify(reader.item.highlights ?? [])) return;
    let active = true;
    const request = navigation.current;
    // Inline changes from Obsidian can change both the excerpt and its offsets.
    void (async () => {
      try {
        const article = await readingRequest<{ item: ReadingItem; markdown: string }>(`/reading/item?id=${encodeURIComponent(reader.item.crate_reading_id)}`, session);
        validateReadingMetadata({ ...article.item });
        if (!active || request !== navigation.current) return;
        let cached = false;
        try { await cacheReadingArticle(session, article.item, article.markdown); cached = true; } catch { /* Preserve the confirmed online article. */ }
        assertReadingSession(session);
        if (!active || request !== navigation.current) return;
        setReader(current => current?.item.crate_reading_id === article.item.crate_reading_id ? { ...current, ...article, availableOffline: cached, sourceHighlights: JSON.stringify(article.item.highlights ?? []) } : current);
        if (!cached) setError('Offline copy could not be updated.');
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : 'Reopen this article to refresh its highlights.'); }
    })();
    return () => { active = false; };
  }, [reader, session]);
  useEffect(() => {
    const item = presentReadingItems(cache?.items ?? [], pending).find(item => item.crate_reading_id === requestedItem);
    if (!session || !item) return; setRequestedItem(null);
    void run(() => open(item, false));
  }, [cache, pending, session, open, run, requestedItem]);
  useEffect(() => {
    if (!reader || reader.item.path) return;
    const saved = cache?.items.find(item => item.source_url && readingUrlIdentity(item.source_url) === readingUrlIdentity(reader.item.source_url));
    if (saved) void open(saved, false);
  }, [cache, reader, open]);
  useEffect(() => {
    let historyFrame = 0;
    const back = () => {
      navigation.current++;
      appBack.current = null;
      // Commit the library before changing history. WebKit can snapshot the current
      // document during pushState; retaining the article here records a stale reader.
      flushSync(() => {
        setReaderMotion('none'); setReader(null); setRequestedItem(null);
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
    setRequestedItem(null); setReaderMotion('slide'); setReader(null);
  };
  const finishReaderClose = useCallback(() => {
    if (appBack.current !== 'closing') return;
    appBack.current = 'traversing'; history.back();
  }, []);
  const queueChange = async (action: PendingReading['action'], intent: Record<string, unknown>) => {
    if (!session) throw new Error('Connect Reading before saving changes.');
    try {
      const work = await queueReading(session, action, intent);
      assertReadingSession(session);
      return work;
    } catch (cause) {
      // An old session's failure must not appear after reconnecting or signing out.
      try { assertReadingSession(session); } catch { throw cause; }
      if (alive.current) showToast('error', cause instanceof Error ? cause.message : 'Could not save this change on your device.');
      throw cause;
    }
  };
  const update = async (item: ReadingItem, changes: ReadingChanges) => {
    if (!session) return;
    // The first edit also migrates native/legacy highlights on the server.
    // Prepare their stable metadata here so follow-up annotations can use it
    // without waiting for that first request to return.
    if (!item.highlight_format && item.highlights?.length && changes.highlights === undefined
      && reader?.item.crate_reading_id === item.crate_reading_id && reader.markdown !== null
      && !pending.some(op => op.intent.id === item.crate_reading_id)) {
      changes = { ...changes, highlights: writeMarkdownHighlights(reader.markdown, item.highlights).highlights };
    }
    validateReadingMetadata({ ...item, ...changes });
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, item[key as keyof ReadingChanges]]));
    const work = await queueChange('update', { id: item.crate_reading_id, changes, before });
    assertReadingSession(session);
    setPending(work);
    void run(() => refresh(session));
  };
  const canSaveLink = (() => {
    try { readingUrl(url); return !saving; } catch { return false; }
  })();
  const save = async () => {
    if (!session || savingRef.current) return;
    // Keep input validation beside the form, without a second alert toast.
    const link = readingUrl(url);
    savingRef.current = true; setSaving(true); setError(null);
    try {
      const work = await queueChange('capture', { url: link });
      assertReadingSession(session);
      if (share) await writeValue(`share:${share}`, null, session);
      setPending(work); setUrl(''); setShare(null);
      showToast('success', navigator.onLine ? 'Link saved' : 'Link saved on this device');
      void run(() => refresh(session));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const visibleItems = useMemo(() => presentReadingItems(cache?.items ?? [], pending), [cache, pending]);
  const openCapture = () => {
    // Mount and focus within the tap so iOS can open its software keyboard.
    flushSync(() => { setError(null); setAdding(true); });
  };
  const visibleReader = useMemo(() => reader && presentReadingItems([reader.item], pending)[0], [reader, pending]);
  // Ordinary edits remain usable while sending. New links need their server ID,
  // and rejected changes or text extraction require settlement before further edits.
  const blockedItemIds = useMemo(() => new Set(pending.flatMap(op => op.action === 'capture' ? [op.id]
    : (op.review || op.action === 'retry') && typeof op.intent.id === 'string' ? [op.intent.id] : [])), [pending]);
  const migratingHighlights = Boolean(visibleReader && !visibleReader.highlight_format && visibleReader.highlights?.length
    && pending.some(op => op.intent.id === visibleReader.crate_reading_id));
  const confirmed = Boolean(session && syncedSession?.id === session.id && syncedSession.token === session.token && syncedSession.generation === session.generation);
  const status = readingSyncStatus({ pending, isOffline, loading: !cache, refreshing: syncing, confirmed, error, recovery });
  const readingDisabled = !session && error === 'Reading is disabled. Enable it in Crate settings.';
  useFeatureSettings('reading', {
    ready: ready && !connecting, connected: Boolean(session), status,
    updateContentReady: ready && !connecting && (!session || Boolean(cache) || Boolean(error)),
    updateReady: ready && !connecting && !adding && !saving && !syncing && !isOffline,
    attention: status.state === 'error' && !readingDisabled ? error || status.label : null,
    unsynced: pending.length > 0 || recovery || Boolean(error && !readingDisabled),
    onRefresh: () => session ? refresh() : connect(),
    onExport: exportReadingData,
    onLogout: async () => {
      setSettingsOpen(false); navigation.current++; setSession(null); setCache(null); setReader(null); setPending([]);
      setError(await logoutReadingApp());
    },
    shortcut: session ? <ShortcutSetup session={session} /> : null,
    issues: <>
      {recovery && <SettingsRow title="Earlier changes need review" description="Export Reading data to keep changes from an earlier sign-in." />}
      {pending.filter(op => op.error || op.review).map(op => <SettingsRow key={op.id} title={op.review ? 'Change needs review' : 'Couldn’t sync'} description={op.error || 'Export Reading data to review this change.'} />)}
    </>,
  });
  if (!ready || (connecting && !session)) return <ReadingOpening />;
  const remindersConnected = Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
  const syncIssue = pending.find(op => op.error || op.review);
  const notices = <>{recovery && <p className="crate-reading__notice">Changes from an earlier sign-in are still stored here. <Button variant="outline" onClick={() => void run(exportReadingData)}>Export earlier changes</Button></p>}
    {error && !adding && <p className="crate-reading__notice" role="alert">{error} <Button variant="outline" onClick={() => { if (session) void run(() => refresh()); else void connect(); }}>Retry</Button></p>}
    {!error && syncIssue && <p className="crate-reading__notice" role="alert">{syncIssue.error || 'A Reading change needs review.'} <Button variant="outline" onClick={() => setSettingsOpen(true)}>Review changes</Button></p>}
  </>;
  return <main className="pwa-screen crate-reading-web" data-pwa-back={!!reader}>
    {!session ? <section className="crate-reading crate-reading-welcome"><div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div><h1>Your reading, everywhere</h1><p>{remindersConnected ? 'Reading uses this app’s existing connection. In Obsidian, enable server reading in Crate settings.' : 'In Obsidian, open Crate settings → Reading → Open web reading to connect this browser.'}</p>{share && <p>Your shared link is kept on this device. Connect Reading here, then return to save it.</p>}{!remindersConnected && <p>To install on iPhone, open your Reading setup link in Safari, then use Share → Add to Home Screen within 10 minutes.</p>}{notices}</section> : <>
      <ReadingLibraryPanel initialSection={featureNavigation?.readingTab} renderLibraryContent={(section, content) => <PwaTabTransition viewKey={section}>{content}</PwaTabTransition>} renderNavigation={props => <PwaDock {...props} section="reading" className="crate-reading__mobile-nav" inert={adding || settingsOpen || !!reader} onAdd={openCapture} />} snapshot={{ items: visibleItems, issues: cache?.issues ?? [], loading: !cache && !error && !visibleItems.length, error: !cache && error ? 'Your library is unavailable. Retry when connected.' : null }} onAdd={openCapture} onOpen={(item, highlight, section) => { setFocusHighlight(highlight); return open(item, true, section); }} onUpdate={update} onRefresh={refresh} onSettings={() => setSettingsOpen(true)} settingsLabel="Open settings" headerActions={<FeatureSwitcherButton />} notice={!reader && notices} activeId={reader?.item.crate_reading_id} pendingItemIds={blockedItemIds} onReaderClosed={finishReaderClose} readerMotion={phoneReader ? window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : readerMotion : undefined}
        beforeListContent={<PwaPullRefreshIndicator enabled={!!cache && !reader && !adding && !settingsOpen} scrollSelector=".crate-reading-web .crate-reading__list-scroll" onRefresh={() => run(() => refresh())} />}
        headerStatus={<><PwaUpdateButton /><ReadingSyncIndicator pending={pending} isOffline={isOffline} loading={!cache} refreshing={syncing} confirmed={syncedSession?.id === session.id && syncedSession.token === session.token && syncedSession.generation === session.generation} error={error} recovery={recovery} onShowStatus={(label, state) => showToast(state === 'error' ? 'error' : state === 'synced' ? 'success' : 'info', `Reading: ${label}`, state)} /></>}
        reader={reader && visibleReader && <ReadingReader deferContentUntilEntered={phoneReader && readerMotion === 'slide'} floatingHighlights highlightCode={highlightReadingCode} autoHideNavigation focusHighlight={focusHighlight} item={visibleReader} markdown={reader.markdown} loadingError={reader.error} onRetryOpen={() => { void open(reader.item); }} status={!reader.item.path ? 'Saved on this device' : reader.availableOffline ? 'Available offline' : undefined} notice={notices} mutationPending={blockedItemIds.has(reader.item.crate_reading_id)} highlightsPending={blockedItemIds.has(reader.item.crate_reading_id) || migratingHighlights} onBack={closeReader} onUpdate={changes => update(visibleReader, changes)} onCopyComplete={() => showToast('success', 'Copied')} onSaveComplete={action => showToast('success', `${action === 'tags' ? 'Tags' : 'Note'} saved${navigator.onLine ? '' : ' on this device'}`)} onRetry={async () => { const work = await queueChange('retry', { id: reader.item.crate_reading_id }); assertReadingSession(session); setPending(work); showToast('info', 'Article extraction requested.'); void run(() => refresh(session)); }} />} />
      {adding && active && !settingsOpen && <ReadingDialog title="Save a link" action={{ label: 'Save', ariaLabel: 'Save link', type: 'submit', form: captureFormId, disabled: !canSaveLink, busy: saving }} busy={saving} onClose={() => setAdding(false)}>{close => <SaveLinkForm id={captureFormId} headerAction url={url} onUrl={setUrl} saving={saving} error={error} onCancel={close} onSave={() => void run(async () => { await save(); close(); })} />}</ReadingDialog>}

    </>}
    <PwaToast toast={toast} />
  </main>;
}
