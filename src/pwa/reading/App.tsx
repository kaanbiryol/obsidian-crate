import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { readingKeys } from './encryption-session';

import type { ReadingHighlight } from '@/reading/core/highlights';
import { writeMarkdownHighlights } from '@/reading/core/markdown-highlights';
import type { ReadingChanges, ReadingItem } from '@/reading/core/model';
import { readingUrl, validateReadingMetadata } from '@/reading/core/model';
import { ReadingReader } from '@/reading/ui/Reader';
import { ReadingDialog, ReadingDialogHost } from '@/reading/ui/ReadingDialog';
import { ReadingLibraryPanel } from '@/reading/ui/ReadingLibrary';
import { SaveLinkForm } from '@/reading/ui/SaveLinkForm';
import { EmptyState } from '@/reminders/components/EmptyState';
import { Button } from '@/ui/shared/Button';
import { useContext, useId, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { FeatureNavigationContext, FeatureSwitcherButton } from '../components/FeatureSwitcherButton';
import { PwaPullRefreshIndicator } from '../components/PwaChrome';
import { PwaDock } from '../components/PwaDock';
import { PwaTabTransition } from '../components/PwaTabTransition';
import { PwaUpdateButton } from '../components/PwaUpdateNotice';
import { AUTH_TOKEN_KEY } from '../config';
import { useSettingsOpen } from '../settings-context';
import { AppSyncIndicator } from '../sync/AppSyncIndicator';
import { PwaReadingDialog } from './PwaReadingDialog';
import { ReadingOpening } from './ReadingOpening';
import { useReadingRuntime } from './ReadingRuntime';
import { useReadingAppearance } from './appearance';
import { queueReading, type ReadingCommand } from './outbox';
import { presentReadingItems } from './pending-view';
import { assertReadingSession, exportReadingData, writeValue } from './storage';
import { useDocumentReaderScroll } from './useDocumentReaderScroll';
import { useReadingArticle } from './useReadingArticle';

export default function ReadingApp() {
  return <ReadingDialogHost.Provider value={PwaReadingDialog}><ReadingAppContent /></ReadingDialogHost.Provider>;
}

function ReadingAppContent() {
  const { preferences } = usePwaPreferences();
  const { appearance, updateAppearance } = useReadingAppearance();
  const captureFormId = useId();
  const featureNavigation = useContext(FeatureNavigationContext);
  const active = featureNavigation?.active !== false;
  const { connection, sync, showToast, saving, setSaving, savingRef } = useReadingRuntime();
  const { session, ready, connecting, cache, pending, setPending, error, setError, recovery, connectionState, adding, setAdding, url, setUrl, share, setShare, alive, run, connect } = connection;
  const { refresh, refreshManually, isOffline } = sync;
  const { reader, readerClosing, readerMotion, open, closeReader, finishReaderClose } = useReadingArticle({ session, cache, pending, alive, setError, run });
  const [focusHighlight, setFocusHighlight] = useState<ReadingHighlight>();
  const [settingsOpen, setSettingsOpen] = useSettingsOpen();
  useDocumentReaderScroll(ready && !!session && active && !!reader, reader?.item.crate_reading_id);
  const queueChange = async (command: ReadingCommand) => {
    if (!session) throw new Error('Connect Reading before saving changes.');
    try {
      const work = await queueReading(session, command);
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
      && !pending.some(op => op.action !== 'capture' && op.intent.id === item.crate_reading_id)) {
      changes = { ...changes, highlights: writeMarkdownHighlights(reader.markdown, item.highlights).highlights };
    }
    validateReadingMetadata({ ...item, ...changes });
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, item[key as keyof ReadingChanges]]));
    const work = await queueChange({ action: 'update', intent: { id: item.crate_reading_id, changes, before } });
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
      const work = await queueChange({ action: 'capture', intent: { url: link, fetchArticle } });
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
    && pending.some(op => op.action !== 'capture' && op.intent.id === visibleReader.crate_reading_id));
  const readingDisabled = !session && connectionState !== 'available';

  if (!ready || (connecting && !session && !readingDisabled)) return <ReadingOpening />;
  const remindersConnected = Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
  const syncIssue = pending.find(op => op.error || op.review);
  const notices = <>{recovery && <p className="crate-reading__notice">Changes from an earlier sign-in are still stored here. <Button variant="outline" onClick={() => void run(exportReadingData)}>Export earlier changes</Button></p>}
    {session && readingKeys() && visibleItems.some(item => item.extraction_status === 'pending') && <p className="crate-reading__notice">Links are saved with end-to-end encryption. Open Obsidian to download articles that this browser cannot access.</p>}
    {error && !readingDisabled && !adding && <p className="crate-reading__notice" role="alert">{error} <Button variant="outline" onClick={() => { if (session) void run(refreshManually); else void connect(); }}>Retry</Button></p>}
    {!error && syncIssue && <p className="crate-reading__notice" role="alert">{syncIssue.error || 'A Reading change needs review.'} <Button variant="outline" onClick={() => setSettingsOpen(true)}>Review changes</Button></p>}
  </>;
  return <main className="pwa-screen crate-reading-web" data-pwa-back={!!reader}>
    {!session && !readingDisabled ? <section className="crate-reading crate-reading-welcome"><div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div><h1>Your reading, everywhere</h1><p>{remindersConnected ? 'Reading uses this app’s existing connection. Open Obsidian once to confirm your Reading folder.' : 'In Obsidian, open Crate settings → Crate web app → Open app to connect this browser.'}</p>{share && <p>Your shared link is kept on this device. Connect Reading here, then return to save it.</p>}{!remindersConnected && <p>To install on iPhone, open your Crate setup link in Safari, then use Share → Add to Home Screen within 10 minutes.</p>}{notices}</section> : <>
      <ReadingLibraryPanel listStyle={preferences.reminderListStyle} initialSection={featureNavigation?.readingTab} renderLibraryContent={(section, content) => <PwaTabTransition viewKey={section}>{content}</PwaTabTransition>} renderNavigation={props => <PwaDock {...props} section="reading" className="crate-reading__mobile-nav" inert={adding || settingsOpen || !!reader || readerClosing} onAdd={openCapture} />} snapshot={{ items: visibleItems, issues: cache?.issues ?? [], loading: !cache && !error && !visibleItems.length, error: !readingDisabled && !cache && error ? 'Your library is unavailable. Retry when connected.' : null }} onAdd={openCapture} onOpen={(item, highlight, section) => { setFocusHighlight(highlight); return open(item, true, section); }} onUpdate={update} onRefresh={refreshManually} onSettings={() => setSettingsOpen(true)} settingsLabel="Open settings" headerActions={<FeatureSwitcherButton />} notice={!reader && notices} activeId={reader?.item.crate_reading_id} pendingItemIds={blockedItemIds} readerClosing={readerClosing} onReaderClosed={finishReaderClose} readerMotion={window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : readerMotion}
        listContent={readingDisabled ? <EmptyState className="crate-reading__empty crate-reading-disabled" icon="book-open"
          title="Connect your Reading folder"
          description={<>In Obsidian, open <strong>Crate settings → Reading</strong> and select <strong>Reading folder</strong>.</>}>
          {share && <p>Your shared link is saved on this device. Connect Reading, then return to save it.</p>}
          <Button variant="outline" size="touch" disabled={connecting || isOffline} aria-busy={connecting} onClick={() => void connect()}>{connecting ? 'Checking…' : 'Check again'}</Button>
          {isOffline && <p role="status">Connect to the internet to check again.</p>}
        </EmptyState> : undefined}
        beforeListContent={<PwaPullRefreshIndicator enabled={!!cache && !reader && !adding && !settingsOpen} scrollSelector=".crate-reading-web .crate-reading__list-scroll" onRefresh={() => run(refreshManually)} />}
        headerStatus={<><PwaUpdateButton /><AppSyncIndicator /></>}
        reader={session && reader && visibleReader && <ReadingReader appearance={appearance} onAppearanceChange={updateAppearance} revealContentTogether deferContentUntilEntered={readerMotion === 'slide'} floatingHighlights autoHideNavigation focusHighlight={focusHighlight} item={visibleReader} markdown={reader.markdown} loadingError={reader.error} onRetryOpen={() => { void open(reader.item); }} status={!reader.item.path ? (cache?.items.some(item => item.crate_reading_id === reader.item.crate_reading_id) ? 'Fetching article' : 'Saved on this device') : reader.availableOffline ? 'Available offline' : undefined} notice={notices} mutationPending={blockedItemIds.has(reader.item.crate_reading_id)} highlightsPending={blockedItemIds.has(reader.item.crate_reading_id) || migratingHighlights} onBack={closeReader} onUpdate={changes => update(visibleReader, changes)} onCopyComplete={() => showToast('success', 'Copied')} onSaveComplete={action => showToast('success', `${action === 'tags' ? 'Tags' : 'Note'} saved${navigator.onLine ? '' : ' on this device'}`)} onRetry={async () => { const work = await queueChange({ action: 'retry', intent: { id: reader.item.crate_reading_id } }); assertReadingSession(session); setPending(work); showToast('info', 'Article extraction requested.'); void run(() => refresh(session)); }} />} />
      {adding && active && !settingsOpen && <ReadingDialog title="Save a link" action={{ label: 'Save', ariaLabel: 'Save link', type: 'submit', form: captureFormId, disabled: !canSaveLink, busy: saving }} busy={saving} onClose={() => setAdding(false)}>{close => <SaveLinkForm id={captureFormId} headerAction url={url} onUrl={setUrl} saving={saving} error={error} onCancel={close} onSave={() => void run(async () => { await save(); close(); })} />}</ReadingDialog>}

    </>}
  </main>;
}
