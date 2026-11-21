import { youtubeVideoId } from '../../core/youtube';
import { useRemindersSettingsStore } from '@/reminders/settings';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import React, { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Notice, TFile } from 'obsidian';
import { readingImageType } from '../../core/article-images';
import type { ReadingImageHost, ReadingImageLoader } from '../useReadingImages';
import type CratePlugin from '../../../plugin/CratePlugin';
import type { ReadingLibrary } from '../../data/library';
import { clearRequestedReadingItem, requestedReadingItem, subscribeReadingRuntime } from '../../runtime';
import { ReadingLibraryPanel, type ReadingLibraryProps } from '../ReadingLibrary';
import { useLocalReadingArticle } from './useLocalReadingArticle';
import { ReadingReader } from '../Reader';
import { AddReadingLinkModal } from './add-link-modal';
import '../reading.scss';
import { ReadingDialogHost } from '../ReadingDialog';
import { ObsidianReadingDialog } from './ObsidianReadingDialog';

import { TabTransition } from '@/ui/shared/navigation/TabTransition';
export function LocalReadingLibrary({ plugin, library, renderNavigation }: { plugin: CratePlugin; library: ReadingLibrary; renderNavigation?: ReadingLibraryProps['renderNavigation'] }) {
	const listStyle = useRemindersSettingsStore(state => state.listStyle);
	const reduceMotion = useReducedMotion();
	const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);
	// The card list is built while this view is shown and released some time after it closes.
	useEffect(() => library.retain(), [library]);
	const { article, item, focusHighlight, open, close, update } = useLocalReadingArticle(library, snapshot.items);
	const requested = useSyncExternalStore(useCallback(listener => subscribeReadingRuntime(plugin, listener), [plugin]), () => requestedReadingItem(plugin));
	useEffect(() => {
		const target = requested && snapshot.items.find(candidate => candidate.crate_reading_id === requested);
		if (!target) return;
		clearRequestedReadingItem(plugin);
		void open(target).catch(() => { new Notice('Could not open the saved article.'); });
	}, [plugin, requested, snapshot.items, open]);
	const capturing = Boolean(item && library.isCapturing(item));
	const notePath = item?.path;
	// Obsidian serves vault files to its own views by resource URL; nothing leaves the device.
	const remote = plugin.settings.reading.images === 'remote';
	const imageLoader = useMemo<ReadingImageLoader>(() => ({ remote, load: path => {
		const file = plugin.app.vault.getAbstractFileByPath(path);
		return Promise.resolve(file instanceof TFile && readingImageType(file.path) ? plugin.app.vault.getResourcePath(file) : null);
	} }), [plugin, remote]);
	const images = useMemo<ReadingImageHost | undefined>(() => notePath ? { ...imageLoader, notePath } : undefined, [imageLoader, notePath]);
	return <ReadingDialogHost.Provider value={ObsidianReadingDialog}><ReadingLibraryPanel images={imageLoader} listStyle={listStyle} snapshot={snapshot}
		renderNavigation={renderNavigation}
		readerMotion={reduceMotion ? 'none' : 'slide'}
		renderLibraryContent={(section, content) => <TabTransition viewKey={section}>{content}</TabTransition>}
		onAdd={() => new AddReadingLinkModal(plugin, open).open()}
		onOpen={open}
		onEnrich={async (target, source) => { await library.enrich(target, source); await open(target); }}
		onRefresh={() => library.refresh()} activeId={item?.crate_reading_id}
		reader={article && item && <ReadingReader floatingHighlights images={images} focusHighlight={focusHighlight} item={capturing ? { ...item, extraction_status: 'pending' } : item} markdown={article.markdown} status={capturing ? "Downloading on this device" : item.path ? "Saved in your vault" : youtubeVideoId(item.source_url) ? "Waiting for video details" : "Waiting for article"} mutationPending={!item.path} highlightsPending={!item.path || capturing} pendingMessage={library.canCaptureLocally ? "Your link is saved in your vault. This device is downloading the article." : "Your link is saved. Crate will fetch the article and create its note, then normal sync will bring it into your vault."} onRetry={library.canCaptureLocally ? async () => { await open(await library.retryCapture(item)); } : undefined} onUpdate={update} onFeedback={(_kind, message) => { new Notice(message); }} onBack={close} onEdit={item.path ? () => { void plugin.app.workspace.openLinkText(item.path, '', true).catch(() => { new Notice('Could not open the reading note. It may have moved.'); }); } : undefined} />} />
	</ReadingDialogHost.Provider>;
}
