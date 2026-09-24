import { ShortcutSetup } from './ShortcutSetup';
import { manifestHrefForUrl } from '@/cloudflare/worker/pwa/pwa-params';
import { logoutReadingApp } from './logout';
import { FeatureSwitcherButton } from '../components/FeatureSwitcherButton';
import { ReadingOpening } from './ReadingOpening';
import { ReadingSyncIndicator } from './ReadingSyncIndicator';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT } from '../config';
import { applyPwaUpdate } from '../apply-update';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ReadingLibraryPanel } from '@/reading/ui/ReadingLibrary';
import { ReadingReader } from '@/reading/ui/Reader';
import { ReadingDialog, ReadingDialogHost } from '@/reading/ui/ReadingDialog';
import { SaveLinkForm } from '@/reading/ui/SaveLinkForm';
import type { ReadingItem, ReadingChanges } from '@/reading/core/model';
import { validateReadingMetadata } from '@/reading/core/model';
import { Button } from '@/ui/shared/Button';
import { PwaReadingDialog } from './PwaReadingDialog';
import { ReadingSettings } from './ReadingSettings';
import { registerPwaServiceWorker } from '../api';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import { useToast } from '../hooks/useToast';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { connectReadingFromReminders, drainReading, loadReading, queueReading, readingRequest } from './api';
import { READING_SESSION_KEY, readingSession, pendingReading, readValue, writeValue, cacheReadingArticle, exportReadingData,
  readingDatabase, type ReadingSession, type ReadingCache, type PendingReading } from './storage';
import { presentReadingItems } from './pending-view';
import { dismissReadingArticleHistory, hasReadingArticleHistory, openReadingArticleHistory } from './article-history';

interface OpenReadingArticle { item: ReadingItem; markdown: string | null; availableOffline: boolean; error?: string }

export default function ReadingApp() {
  return <ReadingDialogHost.Provider value={PwaReadingDialog}><ReadingAppContent /></ReadingDialogHost.Provider>;
}

function ReadingAppContent() {
  usePwaColorScheme();
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
  const [readerMotion, setReaderMotion] = useState<'slide' | 'none'>('none');
  const [phoneReader, setPhoneReader] = useState(() => window.matchMedia('(max-width: 719px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 719px)');
    const changed = () => setPhoneReader(media.matches);
    media.addEventListener('change', changed); return () => media.removeEventListener('change', changed);
  }, []);
  const [adding, setAdding] = useState(false), [url, setUrl] = useState(''), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
  const [share, setShare] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => new URL(location.href).searchParams.get('setup') === 'shortcut');
  const [shortcutOpen, setShortcutOpen] = useState(() => new URL(location.href).searchParams.get('setup') === 'shortcut');
  const [requestedItem, setRequestedItem] = useState(new URL(location.href).searchParams.get('item'));
  const [recovery, setRecovery] = useState(false);
  const [connecting, setConnecting] = useState(false);
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
      const draft = await readValue<{ url: string; title: string }>(`draft:${next.id}`);
      const db = await readingDatabase();
      let hasEarlierChanges = false;
      for (const key of (await db.getAllKeys('values')).filter(key => key.startsWith('pending:') && key !== `pending:${next.id}`)) {
        const value = await db.get('values', key); if (!Array.isArray(value) || value.length) { hasEarlierChanges = true; break; }
      }
      if (!alive.current || readingSession()?.id !== next.id) return;
      setCache(saved ?? null); setPending(work); setRecovery(hasEarlierChanges);
      if (draft?.url || draft?.title) { setUrl(draft.url); setTitle(draft.title); setAdding(true); }
      setSession(next); setError(null);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Reading is unavailable.'); }
    finally { connectingRef.current = false; if (alive.current) setConnecting(false); }
  }, []);
  const refresh = useCallback(async (current = session) => {
    if (!current) return;
    if (refreshing.current) { refreshQueued.current = current; return; }
    refreshing.current = true; setSyncing(true); setSyncedSession(null);
    try {
      const confirmed = await drainReading(current);
      const online = navigator.onLine;
      const data = online ? confirmed ?? await loadReading(current) : await readValue<ReadingCache>(`list:${current.id}`);
      const work = await pendingReading(current);
      const latest = readingSession();
      if (!alive.current || latest?.id !== current.id || latest.token !== current.token || latest.generation !== current.generation) return;
      if (data) { setCache(data); setReader(current => current && data.items.some(item => item.crate_reading_id === current.item.crate_reading_id) ? { ...current, item: data.items.find(item => item.crate_reading_id === current.item.crate_reading_id)! } : null); } setPending(work); setError(null);
      if (online && navigator.onLine && data) setSyncedSession(current);
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
  useEffect(() => {
    alive.current = true;
    void run(async () => {
      try {
        const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]'); if (manifest) manifest.href = manifestHrefForUrl(location.href);
        const fragment = new URLSearchParams(location.hash.slice(1)); const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
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
          const draft = await readValue<{ url: string; title: string }>(`draft:${current.id}`);
          if (draft?.url || draft?.title) { setUrl(draft.url); setTitle(draft.title); setAdding(true); }
        }
        const shareId = new URL(location.href).searchParams.get('share');
        if (shareId) { const draft = await readValue<{ url: string; title: string }>(`share:${shareId}`);
          if (draft) { setUrl(draft.url); setTitle(draft.title); setAdding(true); setShare(shareId); }
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
          navigation.current++; setSession(null); setCache(null); setReader(null); setPending([]); return;
        }
      }
      await refresh(session);
    }); };
    const changed = () => { const current = readingSession(); if (current?.id !== session.id || current.generation !== session.generation || current.token !== session.token) { navigation.current++; setSession(null); setCache(null); setReader(null); setPending([]); if (!share) { setUrl(''); setTitle(''); setAdding(false); } } else reload(); };
    reload();
    const timer = window.setInterval(reload, 30_000);
    window.addEventListener('online', reload); window.addEventListener('storage', changed); window.addEventListener('crate-reading-change', changed); window.addEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.addEventListener('visibilitychange', reload);
    return () => { clearInterval(timer); window.removeEventListener('online', reload); window.removeEventListener('storage', changed); window.removeEventListener('crate-reading-change', changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.removeEventListener('visibilitychange', reload); };
  }, [session, ready, refresh, run, share]);
  useEffect(() => { if (session && ready) void run(() => writeValue(`draft:${session.id}`, { url, title }, session)); }, [session, ready, url, title, run]);
  const open = useCallback(async (item: ReadingItem, animate = true) => {
    if (!session || appBack.current) return;
    const request = ++navigation.current;
    const current = () => alive.current && readingSession()?.id === session.id && readingSession()?.token === session.token
      && request === navigation.current && new URL(location.href).searchParams.get('item') === item.crate_reading_id;
    articleStack.current = openReadingArticleHistory(item.crate_reading_id);
    setReaderMotion(animate ? 'slide' : 'none');
    setReader({ item, markdown: null, availableOffline: false }); setError(null);
    void (async () => {
      let cached = false;
      try {
        const saved = await readValue<{ item: ReadingItem; markdown: string }>(`article:${session.id}:${item.crate_reading_id}`);
        if (saved?.item?.crate_reading_id === item.crate_reading_id && typeof saved.markdown === 'string') {
          validateReadingMetadata({ ...saved.item });
          if (current()) { cached = true; setReader({ item, markdown: saved.markdown, availableOffline: true }); }
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
        setReader({ item: article.item, markdown: article.markdown, availableOffline: cached });
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
    const item = cache?.items.find(item => item.crate_reading_id === requestedItem);
    if (!session || !item) return; setRequestedItem(null);
    void run(() => open(item, false));
  }, [cache, session, open, run, requestedItem]);
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
  const update = async (item: ReadingItem, changes: ReadingChanges) => {
    if (!session) return;
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, item[key as keyof ReadingChanges]]));
    const work = await queueReading(session, 'update', { id: item.crate_reading_id, changes, before });
    if (readingSession()?.id !== session.id) return;
    setPending(work);
    void run(() => refresh(session));
  };
  const save = async () => {
    if (!session || savingRef.current) return; savingRef.current = true; setSaving(true); setError(null);
    try {
      const work = await queueReading(session, 'capture', { url, ...(title.trim() ? { title: title.trim() } : {}) });
      if (share) await writeValue(`share:${share}`, null, session);
      setPending(work); setUrl(''); setTitle(''); setShare(null);
      void run(() => refresh(session));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const visibleItems = useMemo(() => presentReadingItems(cache?.items ?? [], pending), [cache, pending]);
  const visibleReader = useMemo(() => reader && presentReadingItems([reader.item], pending)[0], [reader, pending]);
  const pendingItemIds = useMemo(() => new Set(pending.filter(op => op.action !== 'capture' && typeof op.intent.id === 'string').map(op => String(op.intent.id))), [pending]);
  if (!ready || (connecting && !session)) return <ReadingOpening />;
  const remindersConnected = Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
  const notices = <>{recovery && <p className="crate-reading__notice">Changes from an earlier sign-in are still stored here. <Button variant="outline" onClick={() => void run(exportReadingData)}>Export earlier changes</Button></p>}
    {error && !adding && <p className="crate-reading__notice" role="alert">{error} <Button variant="outline" onClick={() => { if (session) void run(() => refresh()); else void connect(); }}>Retry</Button></p>}
  </>;
  return <main className="crate-reading-web">
    {!session ? <section className="crate-reading crate-reading-welcome"><div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div><h1>Your reading, everywhere</h1><p>{remindersConnected ? 'Reading uses this app’s existing connection. In Obsidian, enable server reading in Crate settings.' : 'In Obsidian, open Crate settings → Reading → Open web reading to connect this browser.'}</p>{share && <p>Your shared link is kept on this device. Connect Reading here, then return to save it.</p>}{!remindersConnected && <p>To install on iPhone, open your Reading setup link in Safari, then use Share → Add to Home Screen within 10 minutes.</p>}{notices}</section> : <>
      <ReadingLibraryPanel snapshot={{ items: visibleItems, issues: cache?.issues ?? [], loading: !cache && !error, error: !cache && error ? 'Your library is unavailable. Retry when connected.' : null }} onAdd={() => { setError(null); setAdding(true); }} onOpen={open} onUpdate={update} onRefresh={refresh} onSettings={() => setSettingsOpen(true)} headerActions={<FeatureSwitcherButton />} notice={!reader && notices} activeId={reader?.item.crate_reading_id} pendingItemIds={pendingItemIds} onReaderClosed={finishReaderClose} readerMotion={phoneReader ? window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : readerMotion : undefined}
        headerTitleContent={<ReadingSyncIndicator pending={pending} isOffline={isOffline} loading={!cache} refreshing={syncing} confirmed={syncedSession?.id === session.id && syncedSession.token === session.token && syncedSession.generation === session.generation} error={error} recovery={recovery} onShowStatus={label => showToast('info', `Reading: ${label}`)} />}
        reader={reader && visibleReader && <ReadingReader item={visibleReader} markdown={reader.markdown} loadingError={reader.error} onRetryOpen={() => { void open(reader.item); }} status={reader.availableOffline ? 'Available offline' : undefined} notice={notices} mutationPending={pendingItemIds.has(reader.item.crate_reading_id)} onBack={closeReader} onUpdate={changes => update(reader.item, changes)} onRetry={async () => { const work = await queueReading(session, 'retry', { id: reader.item.crate_reading_id }); setPending(work); showToast('info', 'Article extraction requested.'); void run(() => refresh(session)); }} />} />
      {adding && <ReadingDialog title="Save a link" busy={saving} onClose={() => setAdding(false)}>{close => <SaveLinkForm url={url} title={title} onUrl={setUrl} onTitle={setTitle} saving={saving} error={error} onCancel={close} onSave={() => void run(async () => { await save(); close(); })} />}</ReadingDialog>}
      {settingsOpen && <ReadingDialog contentClassName={shortcutOpen ? 'crate-reading' : ''} title={shortcutOpen ? "Set up iPhone shortcut" : "Reading settings"} onClose={() => { setSettingsOpen(false); setShortcutOpen(false); }}>{close => shortcutOpen ? <><Button variant="outline" onClick={() => setShortcutOpen(false)}>Back to settings</Button><ShortcutSetup session={session} /></> : <ReadingSettings pending={pending}
        onShortcut={() => setShortcutOpen(true)} onRefresh={() => { close(); void run(() => refresh()); }}
        onExport={() => void run(exportReadingData)} onUpdate={() => void run(async () => { await applyPwaUpdate(); })}
        onLogout={() => { setSettingsOpen(false); setSession(null); setCache(null); setReader(null); void run(async () => { setError(await logoutReadingApp()); }); }} /> }</ReadingDialog>}
    </>}
    {toast && <div className={`toast is-${toast.kind}`} role="status" aria-live="polite">{toast.message}</div>}
  </main>;
}
