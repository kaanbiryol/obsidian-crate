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
import { PwaConnectionBanner } from '../components/PwaConnectionBanner';
import { readingConnectionView } from './connection-view';
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
import { useHeldPending } from './useHeldPending';
import { useReaderArticleKey } from './useReaderArticleKey';
import { exportReadingData } from './storage/storage';
import { useDocumentReaderScroll } from './useDocumentReaderScroll';
import { useReadingArticle } from './useReadingArticle';
import { usePwaReadingImages } from './usePwaReadingImages';
import { useSharedFeatures } from '../shared-features';
import { pendingReadingHighlights, readerStatus, readingItemSyncStatus } from './reader-feedback';
import { useReaderSyncFeedback } from './useReaderSyncFeedback';
import type { PendingReading } from './outbox';
import type { ReadingLibrarySource } from '@/reading/ui/useLibraryPages';
import { queryReadingItems, queryReadingTags } from './api';
import { readOfflineReadingItems } from './storage/storage';
import type { ReadingItem } from '@/reading/core/model';
import type { ReadingSession } from './session/session';

const NO_ITEMS: ReadingItem[] = [];

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
	const { session, readOnly, ready, connecting, cache, pending, error, libraryFailed, recovery, connectionState, adding, url, setUrl, run, connect,
		isCurrentSession, reportSessionError, openCapture: openCaptureForm, closeCapture, sharedLinkReady, takeSharedLink } = connection;
	const { refreshManually, isOffline } = sync;
	const { reader, readerClosing, readerMotion, open, closeReader, finishReaderClose, setOffline } = useReadingArticle({ session, cache, pending, isCurrentSession, reportSessionError, run });
	const [focusHighlight, setFocusHighlight] = useState<ReadingHighlight>();
	const [settingsOpen, setSettingsOpen] = useSettingsOpen();
	useDocumentReaderScroll(ready && !!session && active && !!reader, reader?.item.crate_reading_id);
	const { host: images, loader: imageLoader } = usePwaReadingImages(session, reader?.item.path ? { id: reader.item.crate_reading_id, notePath: reader.item.path } : undefined, useSharedFeatures().readingImages === 'remote');
	const canSaveLink = (() => {
		try { readingUrl(url); return !saving; } catch { return false; }
	})();
	// A refresh made offline read no library, so reconnecting loads one instead of listing an empty inbox.
	const library = cache?.offline ? null : cache;
	// Offline, the library is the articles saved on this device; online, the server lists it page by page.
	const { savedOnly, readingDisabled, connectionText, libraryError } = readingConnectionView({
		isOffline, readOnly, hasSession: !!session, hasCache: !!library, libraryFailed, error, connectionState });
	const offlineItems = useOfflineReadingItems(session, savedOnly, reader?.availableOffline);
	const confirmedItems = savedOnly ? offlineItems ?? NO_ITEMS : library?.items;
	const visibleItems = useMemo(() => presentReadingItems(confirmedItems ?? [], pending), [confirmedItems, pending]);
	const source = useMemo<ReadingLibrarySource | undefined>(() => session && !savedOnly && library ? {
		load: async ({ section, q, tag, cursor }) => {
			// The sync just read the first inbox page; the library shows it without asking again.
			if (section === 'inbox' && !q.trim() && !tag && !cursor) return { items: library.items, cursor: library.cursor ?? null };
			const page = await queryReadingItems(session, { section, q, tag: tag ?? undefined, cursor: cursor ?? undefined });
			return { items: page.items, cursor: page.cursor };
		},
		loadTags: section => queryReadingTags(session, section),
		revision: library, present: items => presentReadingItems(items, pending),
	} : undefined, [session, savedOnly, library, pending]);
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
		if (readOnly) { showToast('info', 'Connect to save links.'); return; }
		if (!session) { showToast('info', 'Choose a Reading folder in Obsidian’s Crate settings to save a link.'); return; }
		// Mount and focus within the tap so iOS can open its software keyboard.
		flushSync(openCaptureForm);
	};
	// A pending delete hides the item, but the reader keeps it while it closes.
	// Its confirmed changes stay shown until the reader reads the article again.
	const readerPending = useHeldPending(reader?.item, pending);
	const readerKey = useReaderArticleKey(reader?.item);
	const visibleReader = useMemo(() => reader && (presentReadingItems([reader.item], readerPending)[0] ?? reader.item), [reader, readerPending]);
	const blockedItemIds = useMemo(() => blockedReadingItemIds(visibleItems, pending), [pending, visibleItems]);
	const updateFromReader = useReaderSyncFeedback({ itemId: reader?.item.crate_reading_id, pending, showToast, claimFailure,
		retry: () => void run(refreshManually), review: () => setSettingsOpen(true),
		update: (item, changes) => updateItem(item, changes, reader ?? undefined),
		current: id => visibleItems.find(item => item.crate_reading_id === id) ?? (visibleReader?.crate_reading_id === id ? visibleReader : undefined) });
	// An article opened from the list carries its pending changes; compare with the confirmed copy.
	const readerHighlights = useMemo(() => reader ? pendingReadingHighlights(confirmedItems?.find(item => item.crate_reading_id === reader.item.crate_reading_id) ?? reader.item, pending) : [], [reader, confirmedItems, pending]);

	if (!ready || (connecting && !session && !readingDisabled)) return <ReadingOpening />;
	// A share stays staged until a connected Reading session copies it into its draft.
	const share = new URL(location.href).searchParams.has('share');
	const notices = <ReadingNotices recovery={recovery} error={connectionText ? null : error} showError={!readingDisabled && !adding}
		connectionText={connectionText} retrying={connecting}
		syncIssue={pending.find(op => op.error || op.review)} onExport={() => void run(exportReadingData)}
		onRetry={() => { if (session) void run(refreshManually); else void connect(); }} onReview={() => setSettingsOpen(true)} />;
	return <main className="pwa-screen crate-reading-web" data-pwa-back={!!reader}>
		{!session && !readingDisabled ? <ReadingWelcome share={share} notices={notices} /> : <>
			<ReadingLibraryPanel images={imageLoader} listStyle={preferences.listStyle} initialSection={featureNavigation?.readingTab}
				renderLibraryContent={(section, content) => <TabTransition viewKey={section}>{content}</TabTransition>}
				renderNavigation={props => <PwaDock {...props} section="reading" className="crate-reading__mobile-nav" inert={adding || settingsOpen || !!reader || readerClosing} addBlocked={readOnly} onAdd={openCapture} />}
				source={source} snapshot={{ items: visibleItems, issues: library?.issues ?? [], loading: (savedOnly ? offlineItems === null : !library && !error) && !visibleItems.length,
					error: libraryError }}
				onAdd={openCapture} onOpen={(item, highlight, section) => { setFocusHighlight(highlight); return open(item, true, section); }}
				onRefresh={refreshManually} onSettings={() => setSettingsOpen(true)} settingsLabel="Open settings" headerActions={<FeatureSwitcherButton />}
				notice={!reader && notices} activeId={reader?.item.crate_reading_id} readerClosing={readerClosing} onReaderClosed={finishReaderClose}
				readerMotion={window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : readerMotion}
				listContent={!readingDisabled && savedOnly && offlineItems !== null && !visibleItems.length ? <EmptyState className="crate-reading__empty" icon="book-open"
					title="Your library isn’t on this device" description="Connect to see it. Articles you save for offline show up here." />
				: readingDisabled ? <EmptyState className="crate-reading__empty crate-reading-disabled" icon="book-open"
					title="Connect your Reading folder"
					description={<>In Obsidian, open <strong>Crate settings → Reading</strong> and select <strong>Reading folder</strong>.</>}>
					{share && <p>Your shared link is saved on this device. Connect Reading, then return to save it.</p>}
					<Button variant="outline" size="touch" disabled={connecting || isOffline} aria-busy={connecting} onClick={() => void connect()}>{connecting ? 'Checking…' : 'Check again'}</Button>
					{isOffline && <p role="status">Connect to the internet to check again.</p>}
				</EmptyState> : undefined}
				beforeListContent={<PwaPullRefreshIndicator enabled={!!cache && !reader && !adding && !settingsOpen} scrollSelector=".crate-reading-web .crate-reading__list-scroll" onRefresh={() => run(refreshManually)} />}
				headerStatus={<><PwaUpdateButton /><AppSyncIndicator /></>}
				reader={session && reader && visibleReader && <ReadingReader appearance={appearance} onAppearanceChange={updateAppearance} images={images}
					revealContentTogether deferContentUntilEntered={readerMotion === 'slide'} floatingHighlights autoHideNavigation focusHighlight={focusHighlight}
					item={visibleReader} articleKey={readerKey} markdown={reader.markdown} loadingError={reader.error} onRetryOpen={() => { void open(reader.item); }}
					status={readerStatus(reader, cache)} notice={notices}
					savedOffline={reader.availableOffline} onOfflineChange={reader.item.path ? setOffline : undefined}
					mutationPending={blockedItemIds.has(reader.item.crate_reading_id)} highlightsPending={blockedItemIds.has(reader.item.crate_reading_id)}
					onBack={closeReader} onUpdate={changes => updateFromReader(visibleReader, changes)}
					syncStatus={reader.item.path ? readingItemSyncStatus(pending, reader.item.crate_reading_id, isOffline) : undefined} pendingHighlights={readerHighlights}
					onCopyComplete={() => showToast('success', 'Copied')} onFeedback={(kind, message) => showToast(kind, message)}
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

/** Earlier-session recovery, then the connection banner or an error, or else the first change that needs attention. */
function ReadingNotices({ recovery, error, showError, connectionText, retrying, syncIssue, onExport, onRetry, onReview }: {
	recovery: boolean; error: string | null; showError: boolean; syncIssue: PendingReading | undefined;
	/** Offline or unable to connect; only articles saved on this device are listed. */
	connectionText: string | null; retrying: boolean; onExport: () => void; onRetry: () => void; onReview: () => void;
}) {
	return <>
		{connectionText && <PwaConnectionBanner text={connectionText} retrying={retrying}
			onRetry={connectionText.startsWith('Offline') ? undefined : onRetry} />}
		{recovery && <p className="crate-reading__notice">{'Changes from an earlier sign-in are still stored here. '}
			<Button variant="outline" onClick={onExport}>Export earlier changes</Button></p>}
		{error && showError && <p className="crate-reading__notice" role="alert">{error}{' '}
			<Button variant="outline" onClick={onRetry}>Retry</Button></p>}
		{!error && syncIssue && <p className="crate-reading__notice" role="alert">{syncIssue.error || 'A Reading change needs review.'}{' '}
			<Button variant="outline" onClick={onReview}>Review changes</Button></p>}
	</>;
}

/** The articles saved on this device, read only while the library shows them: offline, read-only
 * or unreachable. Read again when a copy is saved or removed; null until the first read answers. */
function useOfflineReadingItems(session: ReadingSession | null, offline: boolean, savedChanged: unknown): ReadingItem[] | null {
	const [items, setItems] = useState<ReadingItem[] | null>(null);
	useEffect(() => {
		// Each read decrypts every saved copy, so skip it while the server's library is shown.
		if (!session || !offline) { setItems(null); return; }
		let active = true;
		readOfflineReadingItems(session).then(next => { if (active) setItems(next); }, () => { if (active) setItems([]); });
		return () => { active = false; };
	}, [session, offline, savedChanged]);
	return items;
}
