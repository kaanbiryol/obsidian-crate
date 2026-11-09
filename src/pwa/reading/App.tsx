import { usePwaPreferences } from '../settings/usePwaPreferences';

import type { ReadingHighlight } from '@/reading/core/highlights';
import { readingUrl } from '@/reading/core/model';
import { ReadingReader } from '@/reading/ui/Reader';
import { ReadingDialog, ReadingDialogHost } from '@/reading/ui/ReadingDialog';
import { ReadingLibraryPanel } from '@/reading/ui/ReadingLibrary';
import { SaveLinkForm } from '@/reading/ui/SaveLinkForm';
import { EmptyState } from '@/ui/shared/EmptyState';
import { Button } from '@/ui/shared/Button';
import { useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { FeatureSwitcherButton } from '../components/FeatureSwitcherButton';
import { FeatureNavigationContext } from '../navigation/feature-navigation';
import { PwaPullRefreshIndicator } from '../components/PwaChrome';
import { PwaDock } from '../components/PwaDock';
import { TabTransition } from '../../ui/shared/navigation/TabTransition';
import { PwaUpdateButton } from '../update/PwaUpdateNotice';
import { AUTH_TOKEN_KEY } from '../config';
import { useSettingsOpen } from '../settings/settings-context';
import { AppSyncIndicator } from '../sync/AppSyncIndicator';
import { PwaReadingDialog } from './PwaReadingDialog';
import { ReadingOpening } from './ReadingOpening';
import { useReadingRuntime } from './ReadingRuntime';
import { useReadingAppearance } from './appearance';
import { blockedReadingItemIds, presentReadingItems } from './pending-view';
import { exportReadingData } from './storage/storage';
import { useDocumentReaderScroll } from './useDocumentReaderScroll';
import { useReadingArticle } from './useReadingArticle';
import { pendingReadingHighlights, readerStatus, readingItemSyncStatus } from './reader-feedback';
import { useReaderSyncFeedback } from './useReaderSyncFeedback';
import type { PendingReading } from './outbox';
import type { ReadingLibrarySource } from '@/reading/ui/useLibraryPages';
import { queryReadingItems } from './api';
import { readOfflineReadingItems } from './storage/storage';
import type { ReadingItem } from '@/reading/core/model';
import type { ReadingSession } from './session/session';

export default function ReadingApp() {
	return <ReadingDialogHost.Provider value={PwaReadingDialog}><ReadingAppContent /></ReadingDialogHost.Provider>;
}

function ReadingAppContent() {
	const { preferences } = usePwaPreferences();
	const { appearance, updateAppearance } = useReadingAppearance();
	const captureFormId = useId();
	const featureNavigation = useContext(FeatureNavigationContext);
	const active = featureNavigation?.active !== false;
	const { connection, sync, showToast, claimFailure, saving, saveLink, updateItem, retryArticle, deleteItem } = useReadingRuntime();
	const { session, readOnly, ready, connecting, cache, pending, error, recovery, connectionState, adding, url, setUrl, run, connect,
		isCurrentSession, reportSessionError, openCapture: openCaptureForm, closeCapture, sharedLinkReady, takeSharedLink } = connection;
	const { refreshManually, isOffline } = sync;
	const { reader, readerClosing, readerMotion, open, closeReader, finishReaderClose, setOffline } = useReadingArticle({ session, cache, pending, isCurrentSession, reportSessionError, run });
	const [focusHighlight, setFocusHighlight] = useState<ReadingHighlight>();
	const [settingsOpen, setSettingsOpen] = useSettingsOpen();
	useDocumentReaderScroll(ready && !!session && active && !!reader, reader?.item.crate_reading_id);
	const canSaveLink = (() => {
		try { readingUrl(url); return !saving; } catch { return false; }
	})();
	// Offline, the library is the articles saved on this device; online, the server lists it page by page.
	const offlineItems = useOfflineReadingItems(session, isOffline, reader?.availableOffline);
	const visibleItems = useMemo(() => presentReadingItems((isOffline ? offlineItems : cache?.items) ?? [], pending), [isOffline, offlineItems, cache, pending]);
	const source = useMemo<ReadingLibrarySource | undefined>(() => session && !isOffline && !readOnly && cache ? {
		load: async ({ section, q, tag, cursor }) => {
			// The sync just read the first inbox page; the library shows it without asking again.
			if (section === 'inbox' && !q.trim() && !tag && !cursor) return { items: cache.items, cursor: cache.cursor ?? null };
			const page = await queryReadingItems(session, { section, q, tag: tag ?? undefined, cursor: cursor ?? undefined });
			return { items: page.items, cursor: page.cursor };
		},
		revision: cache, present: items => presentReadingItems(items, pending),
	} : undefined, [session, isOffline, readOnly, cache, pending]);
	// A shared link saves at once, like the iPhone shortcut. Its draft keeps it until
	// the save succeeds, and a failure opens the form with the error beside the link.
	useEffect(() => {
		if (!sharedLinkReady || !session || saving) return;
		takeSharedLink();
		void run(async () => {
			try { await saveLink(open); } catch (cause) { openCaptureForm(); throw cause; }
		});
	}, [sharedLinkReady, session, saving, takeSharedLink, run, saveLink, open, openCaptureForm]);
	const openCapture = () => {
		if (!session) { showToast('info', 'Choose a Reading folder in Obsidian’s Crate settings to save a link.'); return; }
		// Mount and focus within the tap so iOS can open its software keyboard.
		flushSync(openCaptureForm);
	};
	// A pending delete hides the item, but the reader keeps it while it closes.
	const visibleReader = useMemo(() => reader && (presentReadingItems([reader.item], pending)[0] ?? reader.item), [reader, pending]);
	const blockedItemIds = useMemo(() => blockedReadingItemIds(visibleItems, pending), [pending, visibleItems]);
	const readingDisabled = !session && connectionState !== 'available';
	const updateFromReader = useReaderSyncFeedback({ itemId: reader?.item.crate_reading_id, pending, showToast, claimFailure,
		retry: () => void run(refreshManually), review: () => setSettingsOpen(true),
		update: (item, changes) => updateItem(item, changes, reader ?? undefined),
		current: id => visibleItems.find(item => item.crate_reading_id === id) ?? (visibleReader?.crate_reading_id === id ? visibleReader : undefined) });
	const readerHighlights = useMemo(() => reader ? pendingReadingHighlights(cache?.items.find(item => item.crate_reading_id === reader.item.crate_reading_id) ?? reader.item, pending) : [], [reader, cache, pending]);

	if (!ready || (connecting && !session && !readingDisabled)) return <ReadingOpening />;
	// A share stays staged until a connected Reading session copies it into its draft.
	const share = new URL(location.href).searchParams.has('share');
	const notices = <ReadingNotices recovery={recovery} error={error} showError={!readingDisabled && !adding} readOnly={readOnly}
		syncIssue={pending.find(op => op.error || op.review)} offline={isOffline && !!session} onExport={() => void run(exportReadingData)}
		onRetry={() => { if (session) void run(refreshManually); else void connect(); }} onReview={() => setSettingsOpen(true)} />;
	return <main className="pwa-screen crate-reading-web" data-pwa-back={!!reader}>
		{!session && !readingDisabled ? <ReadingWelcome share={share} notices={notices} /> : <>
			<ReadingLibraryPanel listStyle={preferences.reminderListStyle} initialSection={featureNavigation?.readingTab}
				renderLibraryContent={(section, content) => <TabTransition viewKey={section}>{content}</TabTransition>}
				renderNavigation={props => <PwaDock {...props} section="reading" className="crate-reading__mobile-nav" inert={adding || settingsOpen || !!reader || readerClosing} onAdd={openCapture} />}
				source={source} snapshot={{ items: visibleItems, issues: cache?.issues ?? [], loading: !cache && !error && !visibleItems.length,
					error: !readingDisabled && !cache && error ? 'Your library is unavailable. Retry when connected.' : null }}
				onAdd={openCapture} onOpen={(item, highlight, section) => { setFocusHighlight(highlight); return open(item, true, section); }}
				onRefresh={refreshManually} onSettings={() => setSettingsOpen(true)} settingsLabel="Open settings" headerActions={<FeatureSwitcherButton />}
				notice={!reader && notices} activeId={reader?.item.crate_reading_id} readerClosing={readerClosing} onReaderClosed={finishReaderClose}
				readerMotion={window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : readerMotion}
				listContent={readingDisabled ? <EmptyState className="crate-reading__empty crate-reading-disabled" icon="book-open"
					title="Connect your Reading folder"
					description={<>In Obsidian, open <strong>Crate settings → Reading</strong> and select <strong>Reading folder</strong>.</>}>
					{share && <p>Your shared link is saved on this device. Connect Reading, then return to save it.</p>}
					<Button variant="outline" size="touch" disabled={connecting || isOffline} aria-busy={connecting} onClick={() => void connect()}>{connecting ? 'Checking…' : 'Check again'}</Button>
					{isOffline && <p role="status">Connect to the internet to check again.</p>}
				</EmptyState> : undefined}
				beforeListContent={<PwaPullRefreshIndicator enabled={!!cache && !reader && !adding && !settingsOpen} scrollSelector=".crate-reading-web .crate-reading__list-scroll" onRefresh={() => run(refreshManually)} />}
				headerStatus={<><PwaUpdateButton /><AppSyncIndicator /></>}
				reader={session && reader && visibleReader && <ReadingReader appearance={appearance} onAppearanceChange={updateAppearance}
					revealContentTogether deferContentUntilEntered={readerMotion === 'slide'} floatingHighlights autoHideNavigation focusHighlight={focusHighlight}
					item={visibleReader} markdown={reader.markdown} loadingError={reader.error} onRetryOpen={() => { void open(reader.item); }}
					status={readerStatus(reader, cache)} notice={notices}
					savedOffline={reader.availableOffline} onOfflineChange={reader.item.path ? setOffline : undefined}
					mutationPending={blockedItemIds.has(reader.item.crate_reading_id)} highlightsPending={blockedItemIds.has(reader.item.crate_reading_id)}
					onBack={closeReader} onUpdate={changes => updateFromReader(visibleReader, changes)}
					syncStatus={reader.item.path ? readingItemSyncStatus(pending, reader.item.crate_reading_id, isOffline) : undefined} pendingHighlights={readerHighlights}
					onCopyComplete={() => showToast('success', 'Copied')}
					onSaveComplete={action => showToast('success', `${action === 'tags' ? 'Tags' : 'Note'} saved${navigator.onLine ? '' : ' on this device'}`)}
					onRetry={() => retryArticle(reader.item)}
					onDelete={reader.item.path && reader.markdown !== null ? async () => { await deleteItem(visibleReader, reader.markdown!); closeReader(); } : undefined} />} />
			{adding && active && !settingsOpen && <ReadingDialog title="Save a link"
				action={{ label: 'Save', ariaLabel: 'Save link', type: 'submit', form: captureFormId, disabled: !canSaveLink, busy: saving }} busy={saving} onClose={closeCapture}>
				{close => <SaveLinkForm id={captureFormId} headerAction url={url} onUrl={setUrl} saving={saving} error={error} onCancel={close}
					onSave={() => void run(async () => { if (await saveLink(open)) close(); })} />}
			</ReadingDialog>}

		</>}
	</main>;
}

/** Before Reading connects: how to connect it, and the notices that still apply. */
function ReadingWelcome({ share, notices }: { share: boolean; notices: ReactNode }) {
	const remindersConnected = Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
	return <section className="crate-reading crate-reading-welcome">
		<div className="pwa-feature-welcome-action"><FeatureSwitcherButton /></div>
		<h1>Your reading, everywhere</h1>
		<p>{remindersConnected
			? 'Reading uses this app’s existing connection. Open Obsidian once to confirm your Reading folder.'
			: 'In Obsidian, open Crate settings → Crate web app → Open app to connect this browser.'}</p>
		{share && <p>Your shared link is kept on this device. Connect Reading here, then return to save it.</p>}
		{!remindersConnected && <p>To install on iPhone, open your Crate setup link in Safari, then use Share → Add to Home Screen within 10 minutes.</p>}
		{notices}
	</section>;
}

/** Earlier-session recovery, then a connection error or else the first change that needs attention. */
function ReadingNotices({ recovery, error, showError, readOnly, syncIssue, offline, onExport, onRetry, onReview }: {
	recovery: boolean; error: string | null; showError: boolean; readOnly: boolean; syncIssue: PendingReading | undefined;
	/** Offline, only articles saved on this device are listed. */
	offline: boolean; onExport: () => void; onRetry: () => void; onReview: () => void;
}) {
	return <>
		{offline && <p className="crate-reading__notice">Showing articles saved for offline. Connect to see your whole library.</p>}
		{recovery && <p className="crate-reading__notice">{'Changes from an earlier sign-in are still stored here. '}
			<Button variant="outline" onClick={onExport}>Export earlier changes</Button></p>}
		{error && showError && <p className="crate-reading__notice" role="alert">{readOnly && <strong>Unable to connect. </strong>}{error}{' '}
			<Button variant="outline" onClick={onRetry}>{readOnly ? 'Try again' : 'Retry'}</Button></p>}
		{!error && syncIssue && <p className="crate-reading__notice" role="alert">{syncIssue.error || 'A Reading change needs review.'}{' '}
			<Button variant="outline" onClick={onReview}>Review changes</Button></p>}
	</>;
}

/** The articles saved on this device, read again when the app goes offline or a copy is saved or removed. */
function useOfflineReadingItems(session: ReadingSession | null, offline: boolean, savedChanged: unknown): ReadingItem[] {
	const [items, setItems] = useState<ReadingItem[]>([]);
	useEffect(() => {
		if (!session) { setItems([]); return; }
		let active = true;
		readOfflineReadingItems(session).then(next => { if (active) setItems(next); }, () => { if (active) setItems([]); });
		return () => { active = false; };
	}, [session, offline, savedChanged]);
	return items;
}
