import { ReadingDuplicates } from './ReadingDuplicates';
import { DEFAULT_LIST_STYLE, type ListStyle } from '@/ui/shared/list-style';
import { TextField } from '../../ui/shared/TextField';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { ViewHeader } from '../../ui/shared/ViewHeader';
import type { NavigationItem } from '../../ui/shared/NavigationBar';
import { NavigationBar } from '../../ui/shared/NavigationBar';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { FloatingActionButton } from '../../ui/shared/FloatingActionButton';
import { EmptyState } from '../../ui/shared/EmptyState';
import type { ReadingItem } from '../core/model';
import type { ReadingSnapshot } from '../data/library';
import { groupReadingItems, readingSections, readingSource, readingTitle, type ReadingSection } from '../core/reading-presentation';
import { LoadingIndicator } from '@/ui/shared/LoadingIndicator';
import { useContentReveal } from '@/ui/shared/useContentReveal';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { HighlightList } from './HighlightList';
import type { ReadingHighlight } from '../core/highlights';
import { ReadingItemContent } from './ReadingItemContent';
import type { ReadingLibrarySource } from './useLibraryPages';
import { useReadingLibraryQuery } from './useReadingLibraryQuery';
import { ReadingTagFilter } from './ReadingTagFilter';

export interface ReadingLibraryProps {
	listStyle?: ListStyle;
	snapshot: ReadingSnapshot;
	/** A library kept on a server. Without one, `snapshot` holds the whole library. */
	source?: ReadingLibrarySource;
	initialSection?: ReadingSection;
	renderNavigation?: (props: { items: readonly NavigationItem<ReadingSection>[]; activeTab: ReadingSection; onTabChange: (section: ReadingSection) => void; onAdd: () => void; inert: boolean; disabled: boolean }) => React.ReactNode;
	/** Host-owned transitions can retain the previous library while changing sections. */
	renderLibraryContent?: (section: ReadingSection, content: React.ReactNode) => React.ReactNode;
	onAdd: () => void;
	onOpen: (item: ReadingItem, highlight: ReadingHighlight | undefined, section: ReadingSection) => Promise<void>;
	onRefresh: () => Promise<void>;
	onEnrich?: (target: ReadingItem, source: ReadingItem) => Promise<void>;
	onSettings?: () => void;
	settingsLabel?: string;
	headerActions?: React.ReactNode;
	headerStatus?: React.ReactNode;
	activeId?: string;
	reader?: React.ReactNode;
	/** PWA phone navigation; browser history can settle without a second slide. */
	readerMotion?: 'slide' | 'none';
	onReaderClosed?: () => void;
	/** Keep library input blocked until the host finishes its Back traversal. */
	readerClosing?: boolean;
	notice?: React.ReactNode;
	beforeListContent?: React.ReactNode;
	/** Host-owned unavailable state, keeping library navigation mounted. */
	listContent?: React.ReactNode;
}

const sectionIcons = { inbox: 'inbox', favorites: 'star', archived: 'archive', highlights: 'highlighter' };
const navigationItems = readingSections.map(item => ({ ...item, iconName: sectionIcons[item.id] }));
// Matches the server's page, so a local library reveals rows at the same pace.
const PAGE_SIZE = 50;
// Scrolling within this distance of the list's end loads the next page.
const NEAR_END_PX = 800;

/** Shared workspace. Uses the same stacked app layout at every width. */
export function ReadingLibraryPanel({
	listStyle = DEFAULT_LIST_STYLE, renderNavigation, renderLibraryContent, snapshot, source, initialSection = 'inbox', onAdd, onOpen, onRefresh, onEnrich,
	onSettings, settingsLabel = 'Reading settings', headerActions, headerStatus, activeId, reader, readerMotion, onReaderClosed, readerClosing = false,
	notice, beforeListContent, listContent,
}: ReadingLibraryProps) {
	const [section, setSection] = useState<ReadingSection>(initialSection);
	const [query, setQuery] = useState(''), [tag, setTag] = useState<string | null>(null);
	const [visible, setVisible] = useState(PAGE_SIZE);
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set()), [error, setError] = useState<string | null>(null);
	const [exitingReader, setExitingReader] = useState<React.ReactNode>(null);
	const retainReaderOnClose = readerMotion === 'slide';
	// A history swipe reveals the PWA tab bar immediately. Keep its indicator
	// parked at the selected tab while the reader covers an unfinished spring.
	const animateTabIndicator = readerMotion === undefined || !reader;
	const pending = useRef(new Set<string>()), lists = useRef(new Map<ReadingSection, HTMLDivElement>());
	const setListRef = useCallback((node: HTMLDivElement | null) => {
		if (node) lists.current.set(section, node);
		// Retained views can re-enter before unmounting. Keep refs per section so
		// finishing a previous exit cannot clear the currently visible scroll owner.
		return () => { if (lists.current.get(section) === node) lists.current.delete(section); };
	}, [section]);
	const previousArticle = useRef(activeId);
	useEffect(() => {
		if (!activeId && previousArticle.current && !readerClosing) {
			const list = lists.current.get(section);
			const button = list?.querySelector<HTMLButtonElement>(`[data-reading-id="${previousArticle.current}"]`);
			(button ?? list)?.focus({ preventScroll: true });
		}
		if (!readerClosing) previousArticle.current = activeId;
	}, [activeId, readerClosing, section]);
	useEffect(() => {
		if (reader) {
			if (readerMotion !== undefined) setExitingReader(reader);
			return;
		}
		if (!retainReaderOnClose || !exitingReader) { setExitingReader(null); onReaderClosed?.(); return; }
		// transitionend owns normal cleanup; this also handles rotation or a cancelled transition.
		const timer = window.setTimeout(() => { setExitingReader(null); onReaderClosed?.(); }, 1000);
		return () => window.clearTimeout(timer);
	}, [reader, readerMotion, retainReaderOnClose, exitingReader, onReaderClosed]);
	const { listQuery, shownTag, items, excerpts, count, tags, loading, more, pageLoading, loadingMore, pageError, loadMore } = useReadingLibraryQuery({ snapshot, source, section, query, tag });
	const groups = useMemo(() => groupReadingItems(items.slice(0, visible)), [items, visible]);
	// A section that had to load fades its count, tags and list in instead of popping in.
	useContentReveal(loading, () => {
		const list = lists.current.get(section), library = list?.parentElement;
		if (!list || !library) return undefined;
		return [list, ...library.querySelectorAll<HTMLElement>(':scope > .crate-reading__header .view-header-meta, :scope > .crate-reading-tag-filter')];
	});
	// A tag swaps the list in place, so it fades in with the tab dissolve's timing once
	// the tag's results show. Sections and loading states have their own transitions.
	const reduceMotion = useReducedMotion();
	const shownFilter = useRef<{ section: ReadingSection; tag: string | null } | null>(null);
	useLayoutEffect(() => {
		const previous = shownFilter.current;
		shownFilter.current = loading ? null : { section, tag: shownTag };
		if (!previous || loading || reduceMotion || previous.section !== section || previous.tag === shownTag) return;
		const list = lists.current.get(section);
		if (!list) return;
		const style = (list.ownerDocument.defaultView ?? window).getComputedStyle(list);
		const duration = parseFloat(style.getPropertyValue('--pwa-motion-tab-duration'));
		if (!duration) return;
		const animation = list.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: style.getPropertyValue('--pwa-motion-tab-ease').trim() || 'ease-in-out' });
		return () => animation.cancel();
	}, [loading, section, shownTag, reduceMotion]);
	// Removing a local library's last use of the selected tag clears the filter.
	const snapshotItems = snapshot.items;
	useEffect(() => {
		if (!source && tag && !snapshotItems.some(item => item.tags.includes(tag))) { setTag(null); setVisible(PAGE_SIZE); }
	}, [source, tag, snapshotItems]);
	// Near the end, reveal the next rows already loaded, or ask the server for its next page.
	// Runs after each render too, so a list shorter than its scroller keeps filling.
	const loadNearEnd = useCallback(() => {
		const list = lists.current.get(section);
		// A hidden list has no height and would look scrolled to its end.
		if (!list || !list.clientHeight || listContent || loading || pageLoading || pageError) return;
		if (visible >= count && !more) return;
		if (list.scrollHeight - list.scrollTop - list.clientHeight > NEAR_END_PX) return;
		if (visible >= count) loadMore();
		setVisible(value => value + PAGE_SIZE);
	}, [section, listContent, loading, pageLoading, pageError, visible, count, more, loadMore]);
	useEffect(() => { loadNearEnd(); }, [loadNearEnd]);
	const run = (key: string, action: () => Promise<void>) => {
		if (pending.current.has(key)) return;
		pending.current.add(key); setBusy(new Set(pending.current)); setError(null);
		void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not update reading.'))
			.finally(() => { pending.current.delete(key); setBusy(new Set(pending.current)); });
	};
	const resetList = () => { setVisible(PAGE_SIZE); lists.current.get(section)?.scrollTo({ top: 0 }); };
	const selectSection = (next: ReadingSection) => {
		setSection(next); setTag(null);
		if (renderLibraryContent && next !== section) setVisible(PAGE_SIZE);
		else resetList();
	};
	const renderLibrary = (content: React.ReactNode) => renderLibraryContent ? renderLibraryContent(section, content) : content;
	const highlightsCopy = emptyHighlightsCopy(Boolean(listQuery || tag)), linksCopy = emptyLinksCopy(section, Boolean(listQuery || tag));
	return <section className="crate-reading crate-reading-workspace" aria-label="Reading" data-list-style={listStyle} data-reader-open={!!reader} data-reader-motion={readerMotion}>
		<div className="crate-reading__layout">
			<aside className="crate-reading__sidebar" inert={readerMotion !== undefined && (!!reader || readerClosing)}>
				{renderNavigation
					? renderNavigation({ items: navigationItems, activeTab: section, onTabChange: selectSection, onAdd, inert: !!reader || readerClosing, disabled: false })
					: <NavigationBar className="crate-reading__mobile-nav" items={navigationItems} activeTab={section} onTabChange={selectSection} label="Reading filters"
						action="switch-reading-section" animateActiveIndicator={animateTabIndicator} />}

			</aside>
			<div className="crate-reading__library" aria-busy={busy.size > 0} inert={readerMotion !== undefined && (!!reader || readerClosing)}>
				{renderLibrary(<>
				<ViewHeader className="crate-reading__header" title={section === 'inbox' ? 'Reading' : readingSections.find(item => item.id === section)!.label} count={count}
					countUnit={section === 'highlights' ? 'highlight' : 'saved link'} showMeta={!loading && !more} reserveMetaSpace rightContent={<div className="crate-view-header-actions">
						{headerStatus}
						{onSettings && <IconButton size="large" iconSize="l" icon="settings" label={settingsLabel} onClick={onSettings} />}
						<IconButton size="large" iconSize="l" className="crate-reading__add" icon="plus" label="Save a link" onClick={onAdd} />
						{headerActions}
					</div>} />
				<TextField fieldClassName="crate-reading__search" label="Search reading" hideLabel type="search"
					placeholder={section === 'highlights' ? 'Search highlights and notes' : 'Search your reading'} leadingIcon={<ThemeIcon id="search" size="m" aria-hidden="true" />}
					value={query} onChange={event => { setQuery(event.target.value); resetList(); }}
					trailingAction={query && <IconButton size="large" icon="x" label="Clear search" onClick={() => { setQuery(''); resetList(); }} />} />
				<ReadingTagFilter tags={tags} selected={tag} onChange={value => { if (value === tag) return; setTag(value); resetList(); }} />
				{beforeListContent}
				<div className="crate-reading__list-scroll" ref={setListRef} tabIndex={-1} onScroll={loadNearEnd}>
					{notice}
					<ReadingDuplicates items={snapshot.items} busy={busy.has('enrich') || busy.has('open')} onOpen={item => run('open', () => onOpen(item, undefined, section))}
						onEnrich={onEnrich ? (target, source) => run('enrich', () => onEnrich(target, source)) : undefined} />
					{(error || snapshot.error || pageError) && <p className="crate-reading__notice" role="alert">{error || snapshot.error || pageError}{' '}
						<Button variant="outline" disabled={busy.has('refresh')} onClick={() => run('refresh', onRefresh)}>Refresh</Button></p>}
					{snapshot.issues.length > 0 && <ReadingIssues issues={snapshot.issues} />}
					{listContent ?? (loading ? <LoadingIndicator label="Loading Reading" /> : <>
						{section === 'highlights' && (count > 0
							? <HighlightList entries={excerpts.slice(0, visible)} disabled={busy.has('open')}
								onView={(item, highlight) => run('open', () => onOpen(item, highlight, section))} onOpenItem={item => run('open', () => onOpen(item, undefined, section))} />
							: !more && <EmptyState className="crate-reading__empty" icon="highlighter" title={highlightsCopy.title} description={highlightsCopy.description} />)}
						{section !== 'highlights' && items.length === 0 && <EmptyState className="crate-reading__empty" icon="book-open" title={linksCopy.title} description={linksCopy.description}>
							{section === 'inbox' && !listQuery && !tag && <Button variant="outline" className="crate-reading__text-action" onClick={onAdd}>
								<ThemeIcon id="plus" size="m" aria-hidden="true" />Save your first link
							</Button>}
						</EmptyState>}
						{section !== 'highlights' && groups.map(group => <section className="crate-reading__group" key={group.label} aria-label={group.label}>
							<h3>{group.label}</h3>
							<ul className="crate-reading__list">{group.items.map(item => <li className="crate-reading__item" key={item.crate_reading_id} data-selected={activeId === item.crate_reading_id}>
								<Button className="crate-reading__open" data-reading-id={item.crate_reading_id} aria-label={`${readingSource(item.source_url)} ${readingTitle(item)}`}
									aria-current={activeId === item.crate_reading_id ? 'true' : undefined} aria-disabled={busy.has('open')} onClick={() => run('open', () => onOpen(item, undefined, section))}>
									<ReadingItemContent item={item} />
								</Button>
							</li>)}</ul>
						</section>)}
						{more && loadingMore && <LoadingIndicator label="Loading more" />}
					</>)}
				</div>
				{!renderNavigation && <FloatingActionButton className="crate-reading__mobile-add" aria-label="Save a link" onClick={onAdd} animateOnMount={false} />}
				</>)}
			</div>
			<div className="crate-reading__reader-pane" inert={readerMotion !== undefined && !reader} aria-hidden={readerMotion !== undefined && !reader} onTransitionEnd={event => {
				if (event.target === event.currentTarget && event.propertyName === 'transform' && !reader) { setExitingReader(null); onReaderClosed?.(); }
			}}>{reader ?? (retainReaderOnClose ? exitingReader : null)}</div>
		</div>
	</section>;
}

/** Empty highlights, either before any are saved or when filters match none. */
function emptyHighlightsCopy(filtered: boolean): { title: string; description: string } {
	return filtered
		? { title: 'No matching highlights', description: 'Try another passage, note, or article.' }
		: { title: 'Keep the passages that stay with you', description: 'Select text while reading. Your highlights appear here and in your Obsidian notes.' };
}

/** An empty list of saved links, by section, or when the search or tag matches none. */
function emptyLinksCopy(section: ReadingSection, filtered: boolean): { title: string; description: string } {
	if (filtered) return { title: 'No matching links', description: 'Try another title, source, or tag.' };
	if (section === 'inbox') return { title: 'Save something worth your time', description: 'An essay, an idea, a little inspiration. Keep it here for a quieter moment.' };
	if (section === 'favorites') return { title: 'Keep your favorites close', description: 'Star an article to find it here.' };
	return { title: 'A home for what you’ve read', description: 'Finished reading? Archive it. You can always come back.' };
}

function ReadingIssues({ issues }: { issues: ReadingSnapshot['issues'] }) {
	return <details className="crate-reading__notice">
		<summary>{issues.length} {issues.length === 1 ? 'note needs' : 'notes need'} attention</summary>
		<ul>{issues.map(issue => <li key={issue.path}><strong>{issue.path}</strong>: {issue.message}</li>)}</ul>
	</details>;
}
