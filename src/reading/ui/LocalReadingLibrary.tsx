import { youtubeVideoId } from '../core/youtube';
import { useRemindersSettingsStore } from '@/reminders/settings';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import React, { useSyncExternalStore } from 'react';
import { Notice } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import type { ReadingLibrary } from '../data/library';
import { ReadingLibraryPanel, type ReadingLibraryProps } from './ReadingLibrary';
import { useLocalReadingArticle } from './useLocalReadingArticle';
import { ReadingReader } from './Reader';
import { AddReadingLinkModal } from './add-link-modal';
import './reading.scss';

import { TabTransition } from '@/ui/shared/navigation/TabTransition';
export function LocalReadingLibrary({ plugin, library, renderNavigation }: { plugin: CratePlugin; library: ReadingLibrary; renderNavigation?: ReadingLibraryProps['renderNavigation'] }) {
	const listStyle = useRemindersSettingsStore(state => state.listStyle);
	const reduceMotion = useReducedMotion();
	const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);
	const { article, item, focusHighlight, open, close, update } = useLocalReadingArticle(library, snapshot.items);
	const capturing = Boolean(item && library.isCapturing(item));
	return <><ReadingLibraryPanel listStyle={listStyle} snapshot={snapshot}
        renderNavigation={renderNavigation}
        readerMotion={reduceMotion ? 'none' : 'slide'}
        renderLibraryContent={(section, content) => <TabTransition viewKey={section}>{content}</TabTransition>}
		onAdd={() => new AddReadingLinkModal(plugin).open()}
		onOpen={open}
		onRefresh={() => library.refresh()} activeId={item?.crate_reading_id}
		reader={article && item && <ReadingReader floatingHighlights focusHighlight={focusHighlight} item={capturing ? { ...item, extraction_status: 'pending' } : item} markdown={article.markdown} status={capturing ? "Downloading on this device" : item.path ? "Saved in your vault" : youtubeVideoId(item.source_url) ? "Waiting for video details" : "Waiting for article"} mutationPending={!item.path} highlightsPending={!item.path || capturing} pendingMessage={library.canCaptureLocally ? "Your link is saved in your vault. This device is downloading the article." : "Your link is saved. Crate will fetch the article and create its note, then normal sync will bring it into your vault."} onRetry={library.canCaptureLocally ? () => library.retryCapture(item) : undefined} onUpdate={update} onBack={close} onEdit={item.path ? () => { void plugin.app.workspace.openLinkText(item.path, '', true).catch(() => { new Notice('Could not open the reading note. It may have moved.'); }); } : undefined} />} />
	</>;
}
