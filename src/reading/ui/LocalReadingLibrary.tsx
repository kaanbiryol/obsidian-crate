import { useObsidianReducedMotion } from '@/reminders/ui/useObsidianReducedMotion';
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Notice } from 'obsidian';
import type CratePlugin from '../../plugin/CratePlugin';
import type { ReadingLibrary } from '../data/library';
import { ReadingLibraryPanel, type ReadingLibraryProps } from './ReadingLibrary';
import type { ReadingHighlight } from '../core/highlights';
import { ReadingReader } from './Reader';
import { AddReadingLinkModal } from './add-link-modal';
import './reading.scss';

import { TabTransition } from '@/ui/shared/navigation/TabTransition';
export function LocalReadingLibrary({ plugin, library, renderNavigation }: { plugin: CratePlugin; library: ReadingLibrary; renderNavigation?: ReadingLibraryProps['renderNavigation'] }) {
	const reduceMotion = useObsidianReducedMotion();
	const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);
	const [article, setArticle] = useState<Awaited<ReturnType<ReadingLibrary['read']>> | null>(null);
	const [focusHighlight, setFocusHighlight] = useState<ReadingHighlight>();
	const item = article && (snapshot.items.find(item => item.crate_reading_id === article.item.crate_reading_id) ?? article.item);
	const capturing = Boolean(item && library.isCapturing(item));
	useEffect(() => {
		if (!item || !article || (item.extraction_status === article.item.extraction_status && JSON.stringify(item.highlights) === JSON.stringify(article.item.highlights))) return;
		let active = true;
		void library.read(item).then(updated => { if (active) setArticle(updated); }).catch(() => { if (active) new Notice('Reopen the article to read its latest text and highlights.'); });
		return () => { active = false; };
	}, [article, item, library]);
	return <><ReadingLibraryPanel snapshot={snapshot} pendingItemIds={new Set(snapshot.items.filter(item => !item.path).map(item => item.crate_reading_id))}
        renderNavigation={renderNavigation}
        readerMotion={reduceMotion ? 'none' : 'slide'}
        renderLibraryContent={(section, content) => <TabTransition viewKey={section}>{content}</TabTransition>}
		onAdd={() => new AddReadingLinkModal(plugin).open()}
		onOpen={async (item, highlight) => { setFocusHighlight(highlight); setArticle(await library.read(item)); }}
		onUpdate={(item, changes) => library.update(item, changes)}
		onRefresh={() => library.refresh()} onSettings={() => plugin.openSettingsTab()} activeId={item?.crate_reading_id}
		reader={article && item && <ReadingReader floatingHighlights focusHighlight={focusHighlight} item={capturing ? { ...item, extraction_status: 'pending' } : item} markdown={article.markdown} status={capturing ? "Downloading on this device" : item.path ? "Saved in your vault" : "Waiting for article"} mutationPending={!item.path} highlightsPending={!item.path || capturing} pendingMessage={library.canCaptureLocally ? "Your link is saved in your vault. This device is downloading the article." : "Your link is saved. Crate will fetch the article and create its note, then normal sync will bring it into your vault."} onRetry={library.canCaptureLocally ? () => library.retryCapture(item) : undefined} onUpdate={async changes => { await library.update(item, changes); const updated = await library.read({ ...item, ...changes }); setArticle(current => current?.item.crate_reading_id === item.crate_reading_id ? updated : current); }} onBack={() => setArticle(null)} onEdit={item.path ? () => { void plugin.app.workspace.openLinkText(item.path, '', true).catch(() => { new Notice('Could not open the reading note. It may have moved.'); }); } : undefined} />} />
	</>;
}
