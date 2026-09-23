import { ShortcutSetup } from './ShortcutSetup';
import { manifestHrefForUrl } from '@/cloudflare/worker/pwa/pwa-params';
import { logoutReadingApp } from './logout';
import { FeatureSwitcherButton } from '../components/FeatureSwitcherButton';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT } from '../config';
import { applyPwaUpdate } from '../apply-update';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ReadingLibraryPanel } from '@/reading/ui/ReadingLibrary';
import { ReadingReader } from '@/reading/ui/Reader';
import { ReadingDialog } from '@/reading/ui/ReadingDialog';
import { SaveLinkForm } from '@/reading/ui/SaveLinkForm';
import type { ReadingItem, ReadingChanges } from '@/reading/core/model';
import { validateReadingMetadata } from '@/reading/core/model';
import { Button } from '@/ui/shared/Button';
import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import { ReadingThemeIcon } from './ReadingThemeIcon';
import { registerPwaServiceWorker } from '../api';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { connectReadingFromReminders, drainReading, loadReading, queueReading, readingRequest } from './api';
import { READING_SESSION_KEY, readingSession, pendingReading, readValue, writeValue, cacheReadingArticle, exportReadingData,
  readingDatabase, type ReadingSession, type ReadingCache, type PendingReading } from './storage';

export default function ReadingApp() {
  return <ThemeIconProvider renderer={ReadingThemeIcon}><ReadingAppContent /></ThemeIconProvider>;
}

function ReadingAppContent() {
  usePwaColorScheme();
  const [session, setSession] = useState<ReadingSession | null>(null), [ready, setReady] = useState(false);
  const [cache, setCache] = useState<ReadingCache | null>(null), [pending, setPending] = useState<PendingReading[]>([]);
  const [error, setError] = useState<string | null>(null), [status, setStatus] = useState('');
  const [reader, setReader] = useState<{ item: ReadingItem; markdown: string } | null>(null);
  const [adding, setAdding] = useState(false), [url, setUrl] = useState(''), [title, setTitle] = useState(''), [saving, setSaving] = useState(false);
  const [share, setShare] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => new URL(location.href).searchParams.get('setup') === 'shortcut');
  const [shortcutOpen, setShortcutOpen] = useState(() => new URL(location.href).searchParams.get('setup') === 'shortcut');
  const [requestedItem, setRequestedItem] = useState(new URL(location.href).searchParams.get('item'));
  const [recovery, setRecovery] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const alive = useRef(true), refreshing = useRef(false), savingRef = useRef(false), connectingRef = useRef(false);
  const navigation = useRef(0);
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
    if (!current || refreshing.current) return; refreshing.current = true;
    try {
      await drainReading(current);
      const data = navigator.onLine ? await loadReading(current) : await readValue<ReadingCache>(`list:${current.id}`);
      const work = await pendingReading(current);
      if (!alive.current || readingSession()?.id !== current.id) return;
      if (data) { setCache(data); setReader(current => current && data.items.some(item => item.crate_reading_id === current.item.crate_reading_id) ? { ...current, item: data.items.find(item => item.crate_reading_id === current.item.crate_reading_id)! } : null); } setPending(work); setError(null);
      setStatus(navigator.onLine ? '' : 'Offline · showing saved Reading data');
    } finally { refreshing.current = false; }
  }, [session]);
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
  const open = useCallback(async (item: ReadingItem) => {
    if (!session) return;
    const request = ++navigation.current;
    let article: { item: ReadingItem; markdown: string } | undefined;
    if (navigator.onLine) { article = await readingRequest<{ item: ReadingItem; markdown: string }>(`/reading/item?id=${encodeURIComponent(item.crate_reading_id)}`, session);
      validateReadingMetadata({ ...article.item }); await cacheReadingArticle(session, article.item, article.markdown); }
    else article = await readValue(`article:${session.id}:${item.crate_reading_id}`);
    if (!alive.current || readingSession()?.id !== session.id || request !== navigation.current || new URL(location.href).searchParams.get('section') !== 'reading') return;
    if (!article) throw new Error('This article has not been downloaded. Open it once while connected.');
    setReader(article); setStatus('Available offline');
    const nextUrl = `/notifications?section=reading&item=${encodeURIComponent(item.crate_reading_id)}`;
    if ((history.state as { readingArticle?: boolean } | null)?.readingArticle) history.replaceState({ readingArticle: true }, '', nextUrl);
    else history.pushState({ readingArticle: true }, '', nextUrl);
  }, [session]);
  useEffect(() => {
    const item = cache?.items.find(item => item.crate_reading_id === requestedItem);
    if (!session || !item) return; setRequestedItem(null);
    if (!(history.state as { readingArticle?: boolean } | null)?.readingArticle) history.replaceState(null, '', '/notifications?section=reading');
    void run(() => open(item));
  }, [cache, session, open, run, requestedItem]);
  useEffect(() => { const back = () => { navigation.current++; setReader(null); setStatus(''); setRequestedItem(new URL(location.href).searchParams.get('item')); }; window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back); }, []);
  const update = async (item: ReadingItem, changes: ReadingChanges) => {
    if (!session) return;
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, item[key as keyof ReadingChanges]]));
    await queueReading(session, 'update', { id: item.crate_reading_id, changes, before }); setPending(await pendingReading(session));
    setStatus('Change kept on this device until the server confirms it.'); await refresh();
  };
  const save = async () => {
    if (!session || savingRef.current) return; savingRef.current = true; setSaving(true); setError(null);
    try {
      await queueReading(session, 'capture', { url, ...(title.trim() ? { title: title.trim() } : {}) });
      if (share) await writeValue(`share:${share}`, null, session);
      setPending(await pendingReading(session)); setAdding(false); setUrl(''); setTitle(''); setShare(null);
      setStatus('Link kept on this device until the server confirms it.'); await refresh();
    } finally { savingRef.current = false; setSaving(false); }
  };
  if (!ready || (connecting && !session)) return <main className="crate-reading" role="status">Opening Reading…</main>;
  const remindersConnected = Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
  const notices = <>{recovery && <p className="crate-reading__notice">Changes from an earlier sign-in are still stored here. <Button variant="outline" onClick={() => void run(exportReadingData)}>Export earlier changes</Button></p>}
    {error && !adding && <p className="crate-reading__notice" role="alert">{error} <Button variant="outline" onClick={() => { if (session) void run(() => refresh()); else void connect(); }}>Retry</Button></p>}
    {status && status !== 'Available offline' && <p className="crate-reading__notice" role="status">{status}</p>}
    {pending.length > 0 && <details className="crate-reading__notice" open><summary>{pending.length} pending {pending.length === 1 ? 'change' : 'changes'}</summary><ul>{pending.map(op => <li key={op.id}>{op.action === 'capture' ? String(op.intent.url) : 'Reading update'} — {op.error ?? 'Waiting for server confirmation'}{op.review ? ' · Review required' : ''}</li>)}</ul><Button variant="outline" onClick={() => void run(() => refresh())}>Retry saved changes</Button><Button variant="outline" onClick={() => void run(exportReadingData)}>Export pending work</Button></details>}</>;
  return <main className="crate-reading-web">
    {!session ? <section className="crate-reading crate-reading-welcome"><div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div><h1>Your reading, everywhere</h1><p>{remindersConnected ? 'Reading uses this app’s existing connection. In Obsidian, enable server reading in Crate settings.' : 'In Obsidian, open Crate settings → Reading → Open web reading to connect this browser.'}</p>{share && <p>Your shared link is kept on this device. Connect Reading here, then return to save it.</p>}{!remindersConnected && <p>To install on iPhone, open your Reading setup link in Safari, then use Share → Add to Home Screen within 10 minutes.</p>}{notices}</section> : <>
      <ReadingLibraryPanel snapshot={{ items: cache?.items ?? [], issues: cache?.issues ?? [], loading: !cache && !error, error: !cache && error ? 'Your library is unavailable. Retry when connected.' : null }} onAdd={() => { setError(null); setAdding(true); }} onOpen={open} onUpdate={update} onRefresh={refresh} onSettings={() => setSettingsOpen(true)} headerActions={<FeatureSwitcherButton />} notice={!reader && notices} activeId={reader?.item.crate_reading_id}
        reader={reader && <ReadingReader item={reader.item} markdown={reader.markdown} status="Available offline" notice={notices} onBack={() => history.back()} onUpdate={changes => update(reader.item, changes)} onRetry={async () => { await queueReading(session, 'retry', { id: reader.item.crate_reading_id }); await refresh(); setStatus('Article extraction requested.'); }} />} />
      {adding && <ReadingDialog title="Save a link" busy={saving} onClose={() => setAdding(false)}><SaveLinkForm url={url} title={title} onUrl={setUrl} onTitle={setTitle} saving={saving} error={error} onCancel={() => setAdding(false)} onSave={() => void run(save)} /></ReadingDialog>}
      {settingsOpen && <ReadingDialog className="crate-reading-settings-dialog" title={shortcutOpen ? "Set up iPhone shortcut" : "Reading settings"} onClose={() => { setSettingsOpen(false); setShortcutOpen(false); }}><div className="crate-reading-settings">{shortcutOpen ? <><Button variant="outline" onClick={() => setShortcutOpen(false)}>Back to settings</Button><ShortcutSetup session={session} /></> : <><Button variant="outline" onClick={() => setShortcutOpen(true)}>Set up iPhone shortcut</Button><p>Your opened articles are available offline. This device keeps up to 50 articles or 20 MB.</p><Button variant="outline" onClick={() => { setSettingsOpen(false); void run(() => refresh()); }}>Refresh library</Button><Button variant="outline" onClick={() => void run(exportReadingData)}>Export Reading data</Button><Button variant="outline" onClick={() => void run(async () => { await applyPwaUpdate(); })}>Update app</Button><Button variant="outline" onClick={() => { setSettingsOpen(false); setSession(null); setCache(null); setReader(null); void run(async () => { setError(await logoutReadingApp()); }); }}>Log out and clear device data</Button></>}</div></ReadingDialog>}
    </>}
  </main>;
}
