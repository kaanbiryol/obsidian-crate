import { useReadingSession } from './useReadingSession';
import { useReadingSync } from './useReadingSync';
import { useReadingArticle } from './useReadingArticle';
import { useReadingAppearance } from './appearance';
import { PwaUpdateButton } from '../components/PwaUpdateNotice';
import { useDocumentReaderScroll } from './useDocumentReaderScroll';
import { PwaToast } from '../components/PwaToast';
import { PwaTabTransition } from '../components/PwaTabTransition';
import { ShortcutSetup } from './ShortcutSetup';
import { logoutReadingApp } from './logout';
import { PwaDock } from '../components/PwaDock';
import { FeatureSwitcherButton, FeatureNavigationContext } from '../components/FeatureSwitcherButton';
import { PwaPullRefreshIndicator } from '../components/PwaChrome';
import { ReadingOpening } from './ReadingOpening';
import { ReadingSyncIndicator, readingSyncStatus } from './ReadingSyncIndicator';
import { AUTH_TOKEN_KEY } from '../config';
import React, { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ReadingLibraryPanel } from '@/reading/ui/ReadingLibrary';
import { ReadingReader } from '@/reading/ui/Reader';
import { ReadingDialog, ReadingDialogHost } from '@/reading/ui/ReadingDialog';
import { SaveLinkForm } from '@/reading/ui/SaveLinkForm';
import type { ReadingHighlight } from '@/reading/core/highlights';
import { writeMarkdownHighlights } from '@/reading/core/markdown-highlights';
import type { ReadingItem, ReadingChanges } from '@/reading/core/model';
import { readingUrl, validateReadingMetadata } from '@/reading/core/model';
import { Button } from '@/ui/shared/Button';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { PwaReadingDialog } from './PwaReadingDialog';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import { SettingsRow } from '../components/SettingsRow';
import { useToast } from '../hooks/useToast';
import { useSyncFailureToast } from '../hooks/useSyncFailureToast';
import { queueReading } from './api';
import { assertReadingSession, writeValue, exportReadingData, type PendingReading } from './storage';
import { presentReadingItems } from './pending-view';

export default function ReadingApp() {
  return <ReadingDialogHost.Provider value={PwaReadingDialog}><ReadingAppContent /></ReadingDialogHost.Provider>;
}

function ReadingAppContent() {
  const { appearance, updateAppearance } = useReadingAppearance();
  const captureFormId = useId();
  const featureNavigation = useContext(FeatureNavigationContext);
  const active = featureNavigation?.active !== false;
  const { toast, showToast } = useToast();
  const connection = useReadingSession();
  const { session, ready, connecting, cache, pending, setPending, error, setError, recovery, connectionState,
    adding, setAdding, url, setUrl, share, setShare, alive, run, connect, resetSession } = connection;
  const { refresh, syncing, syncedSession, isOffline } = useReadingSync(connection);
  const { reader, readerMotion, open, closeReader, finishReaderClose } = useReadingArticle({ session, cache, pending, alive, setError, run });
  const [focusHighlight, setFocusHighlight] = useState<ReadingHighlight>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [settingsOpen, setSettingsOpen] = useSettingsOpen();
  const previousSession = useRef(session);
  useEffect(() => {
    if (previousSession.current && !session) setSettingsOpen(false);
    previousSession.current = session;
  }, [session, setSettingsOpen]);
  useDocumentReaderScroll(ready && !!session && active && !!reader, reader?.item.crate_reading_id);
  useSyncFailureToast({
    scope: session ? JSON.stringify([session.id, session.token, session.generation]) : null,
    ready,
    operationIds: pending.filter(op => op.sessionId === session?.id && (op.review || op.error && (op.retryAt === undefined || (op.attempts ?? 0) >= 3))).map(op => op.id),
    feature: 'Reading', showToast,
    isCurrent: () => { if (!session) return false; try { assertReadingSession(session); return true; } catch { return false; } },
  });
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
      const fetchArticle = true;
      const work = await queueChange('capture', { url: link, fetchArticle });
      assertReadingSession(session);
      if (share) await writeValue(`share:${share}`, null, session);
      setPending(work); setUrl(''); setShare(null);
      showToast('success', navigator.onLine ? 'Link saved' : 'Link saved on this device');
      void run(() => refresh(session));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const visibleItems = useMemo(() => presentReadingItems(cache?.items ?? [], pending), [cache, pending]);
  const openCapture = () => {
    if (!session) { showToast('info', 'Choose a Reading folder in Obsidian’s Crate settings to save a link.'); return; }
    // Mount and focus within the tap so iOS can open its software keyboard.
    flushSync(() => { setError(null); setAdding(true); });
  };
  const visibleReader = useMemo(() => reader && presentReadingItems([reader.item], pending)[0], [reader, pending]);
  // Ordinary edits remain usable while sending. New links need their server ID,
  // and rejected changes or text extraction require settlement before further edits.
  const blockedItemIds = useMemo(() => new Set([...visibleItems.filter(item => !item.path).map(item => item.crate_reading_id), ...pending.flatMap(op => op.action === 'capture' ? [op.id]
    : (op.review || op.action === 'retry') && typeof op.intent.id === 'string' ? [op.intent.id] : [])]), [pending, visibleItems]);
  const migratingHighlights = Boolean(visibleReader && !visibleReader.highlight_format && visibleReader.highlights?.length
    && pending.some(op => op.intent.id === visibleReader.crate_reading_id));
  const confirmed = Boolean(session && syncedSession?.id === session.id && syncedSession.token === session.token && syncedSession.generation === session.generation);
  const status = readingSyncStatus({ pending, isOffline, loading: !cache, refreshing: syncing, confirmed, error, recovery });
  const readingDisabled = !session && connectionState !== 'available';
  useFeatureSettings('reading', {
    ready: ready && !connecting, connected: Boolean(session), status,
    updateContentReady: ready && !connecting && (!session || Boolean(cache) || Boolean(error)),
    updateReady: ready && !connecting && !adding && !saving && !syncing && !isOffline,
    attention: status.state === 'error' && !readingDisabled ? error || status.label : null,
    unsynced: pending.length > 0 || recovery || Boolean(error && !readingDisabled),
    onRefresh: () => session ? refresh() : connect(),
    onLogout: async () => {
      setSettingsOpen(false); resetSession();
      setError(await logoutReadingApp());
    },
    shortcut: session ? <ShortcutSetup session={session} /> : null,
    issues: <>
      {recovery && <SettingsRow title="Earlier changes need review" description="Changes from an earlier sign-in are still stored on this device." />}
      {pending.filter(op => op.error || op.review).map(op => <SettingsRow key={op.id} title={op.review ? 'Change needs review' : 'Couldn’t sync'} description={op.error || 'This change is still stored on this device.'} />)}
    </>,
  });
  if (!ready || (connecting && !session && !readingDisabled)) return <ReadingOpening />;
  const remindersConnected = Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
  const syncIssue = pending.find(op => op.error || op.review);
  const notices = <>{recovery && <p className="crate-reading__notice">Changes from an earlier sign-in are still stored here. <Button variant="outline" onClick={() => void run(exportReadingData)}>Export earlier changes</Button></p>}
    {error && !readingDisabled && !adding && <p className="crate-reading__notice" role="alert">{error} <Button variant="outline" onClick={() => { if (session) void run(() => refresh()); else void connect(); }}>Retry</Button></p>}
    {!error && syncIssue && <p className="crate-reading__notice" role="alert">{syncIssue.error || 'A Reading change needs review.'} <Button variant="outline" onClick={() => setSettingsOpen(true)}>Review changes</Button></p>}
  </>;
  return <main className="pwa-screen crate-reading-web" data-pwa-back={!!reader}>
    {!session && !readingDisabled ? <section className="crate-reading crate-reading-welcome"><div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div><h1>Your reading, everywhere</h1><p>{remindersConnected ? 'Reading uses this app’s existing connection. Open Obsidian once to confirm your Reading folder.' : 'In Obsidian, open Crate settings → Crate web app → Open app to connect this browser.'}</p>{share && <p>Your shared link is kept on this device. Connect Reading here, then return to save it.</p>}{!remindersConnected && <p>To install on iPhone, open your Crate setup link in Safari, then use Share → Add to Home Screen within 10 minutes.</p>}{notices}</section> : <>
      <ReadingLibraryPanel initialSection={featureNavigation?.readingTab} renderLibraryContent={(section, content) => <PwaTabTransition viewKey={section}>{content}</PwaTabTransition>} renderNavigation={props => <PwaDock {...props} section="reading" className="crate-reading__mobile-nav" inert={adding || settingsOpen || !!reader} onAdd={openCapture} />} snapshot={{ items: visibleItems, issues: cache?.issues ?? [], loading: !cache && !error && !visibleItems.length, error: !readingDisabled && !cache && error ? 'Your library is unavailable. Retry when connected.' : null }} onAdd={openCapture} onOpen={(item, highlight, section) => { setFocusHighlight(highlight); return open(item, true, section); }} onUpdate={update} onRefresh={refresh} onSettings={() => setSettingsOpen(true)} settingsLabel="Open settings" headerActions={<FeatureSwitcherButton />} notice={!reader && notices} activeId={reader?.item.crate_reading_id} pendingItemIds={blockedItemIds} onReaderClosed={finishReaderClose} readerMotion={window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : readerMotion}
        listContent={readingDisabled ? <div className="crate-reading__empty crate-reading-disabled">
          <ThemeIcon id="book-open" size="xl" aria-hidden="true" />
          <h2>Connect your Reading folder</h2>
          <p>In Obsidian, open <strong>Crate settings → Reading</strong> and select <strong>Reading folder</strong>.</p>
          {share && <p>Your shared link is saved on this device. Connect Reading, then return to save it.</p>}
          <Button variant="outline" size="touch" disabled={connecting || isOffline} aria-busy={connecting} onClick={() => void connect()}>{connecting ? 'Checking…' : 'Check again'}</Button>
          {isOffline && <p role="status">Connect to the internet to check again.</p>}
        </div> : undefined}
        beforeListContent={<PwaPullRefreshIndicator enabled={!!cache && !reader && !adding && !settingsOpen} scrollSelector=".crate-reading-web .crate-reading__list-scroll" onRefresh={() => run(() => refresh())} />}
        headerStatus={<><PwaUpdateButton />{session && <ReadingSyncIndicator pending={pending} isOffline={isOffline} loading={!cache} refreshing={syncing} confirmed={syncedSession?.id === session.id && syncedSession.token === session.token && syncedSession.generation === session.generation} error={error} recovery={recovery} onShowStatus={(label, state) => showToast(state === 'error' ? 'error' : state === 'synced' ? 'success' : 'info', `Reading: ${label}`, state)} />}</>}
        reader={session && reader && visibleReader && <ReadingReader appearance={appearance} onAppearanceChange={updateAppearance} revealContentTogether deferContentUntilEntered={readerMotion === 'slide'} floatingHighlights autoHideNavigation focusHighlight={focusHighlight} item={visibleReader} markdown={reader.markdown} loadingError={reader.error} onRetryOpen={() => { void open(reader.item); }} status={!reader.item.path ? (cache?.items.some(item => item.crate_reading_id === reader.item.crate_reading_id) ? 'Fetching article' : 'Saved on this device') : reader.availableOffline ? 'Available offline' : undefined} notice={notices} mutationPending={blockedItemIds.has(reader.item.crate_reading_id)} highlightsPending={blockedItemIds.has(reader.item.crate_reading_id) || migratingHighlights} onBack={closeReader} onUpdate={changes => update(visibleReader, changes)} onCopyComplete={() => showToast('success', 'Copied')} onSaveComplete={action => showToast('success', `${action === 'tags' ? 'Tags' : 'Note'} saved${navigator.onLine ? '' : ' on this device'}`)} onRetry={async () => { const work = await queueChange('retry', { id: reader.item.crate_reading_id }); assertReadingSession(session); setPending(work); showToast('info', 'Article extraction requested.'); void run(() => refresh(session)); }} />} />
      {adding && active && !settingsOpen && <ReadingDialog title="Save a link" action={{ label: 'Save', ariaLabel: 'Save link', type: 'submit', form: captureFormId, disabled: !canSaveLink, busy: saving }} busy={saving} onClose={() => setAdding(false)}>{close => <SaveLinkForm id={captureFormId} headerAction url={url} onUrl={setUrl} saving={saving} error={error} onCancel={close} onSave={() => void run(async () => { await save(); close(); })} />}</ReadingDialog>}

    </>}
    <PwaToast toast={toast} />
  </main>;
}
