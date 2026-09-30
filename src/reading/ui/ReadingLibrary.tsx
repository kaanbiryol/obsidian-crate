import { TextField } from '../../ui/shared/TextField';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { ViewHeader } from '../../ui/shared/ViewHeader';
import type { NavigationItem } from '../../ui/shared/NavigationBar';
import { NavigationBar } from '../../ui/shared/NavigationBar';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { FloatingActionButton } from '../../reminders/components/FloatingActionButton';
import { EmptyState } from '../../reminders/components/EmptyState';
import type { ReadingChanges, ReadingItem } from '../core/model';
import type { ReadingSnapshot } from '../data/library';
import { filterReadingHighlights, filterReadingItems, groupReadingItems, readingSections, readingSource, type ReadingSection } from './reading-presentation';
import { LoadingIndicator } from '@/ui/shared/LoadingIndicator';
import { HighlightList } from './HighlightList';
import type { ReadingHighlight } from '../core/highlights';
import { ReadingSourceIcon } from './ReadingSourceIcon';

export interface ReadingLibraryProps {
	snapshot: ReadingSnapshot;
	initialSection?: ReadingSection;
	renderNavigation?: (props: { items: readonly NavigationItem<ReadingSection>[]; activeTab: ReadingSection; onTabChange: (section: ReadingSection) => void; onAdd: () => void; inert: boolean; disabled: boolean }) => React.ReactNode;
	/** Host-owned transitions can retain the previous library while changing sections. */
	renderLibraryContent?: (section: ReadingSection, content: React.ReactNode) => React.ReactNode;
	onAdd: () => void;
	onOpen: (item: ReadingItem, highlight: ReadingHighlight | undefined, section: ReadingSection) => Promise<void>;
	onUpdate: (item: ReadingItem, changes: ReadingChanges) => Promise<void>;
	onRefresh: () => Promise<void>;
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
	pendingItemIds?: ReadonlySet<string>;
}

const sectionIcons = { inbox: 'inbox', favorites: 'star', archived: 'archive', highlights: 'highlighter' };
const navigationItems = readingSections.map(item => ({ ...item, iconName: sectionIcons[item.id] }));
const PAGE_SIZE = 100;

/** Shared workspace. Uses the same stacked app layout at every width. */
export function ReadingLibraryPanel({ renderNavigation, renderLibraryContent, snapshot, initialSection = 'inbox', onAdd, onOpen, onUpdate, onRefresh, onSettings, settingsLabel = 'Reading settings', headerActions, headerStatus, activeId, reader, readerMotion, onReaderClosed, readerClosing = false, notice, beforeListContent, listContent, pendingItemIds }: ReadingLibraryProps) {
	const [section, setSection] = useState<ReadingSection>(initialSection);
	const [query, setQuery] = useState(''), [tag, setTag] = useState<string | null>(null);
	const [articleFilter, setArticleFilter] = useState('');
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
	const items = useMemo(() => filterReadingItems(snapshot.items, section, query, tag), [snapshot.items, section, query, tag]);
	const excerpts = useMemo(() => filterReadingHighlights(items, query, articleFilter), [items, articleFilter, query]);
	const count = section === 'highlights' ? excerpts.length : items.length;
	const groups = useMemo(() => groupReadingItems(items.slice(0, visible)), [items, visible]);
	const tags = useMemo(() => [...new Set(snapshot.items.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b)), [snapshot.items]);
	useEffect(() => {
		if (tag && !tags.includes(tag)) { setTag(null); setVisible(PAGE_SIZE); }
	}, [tag, tags]);
	const run = (key: string, action: () => Promise<void>) => {
		if (pending.current.has(key)) return;
		pending.current.add(key); setBusy(new Set(pending.current)); setError(null);
		void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not update reading.'))
			.finally(() => { pending.current.delete(key); setBusy(new Set(pending.current)); });
	};
	const resetList = () => { setVisible(PAGE_SIZE); lists.current.get(section)?.scrollTo({ top: 0 }); };
	const selectSection = (next: ReadingSection) => {
		setSection(next); setTag(null); setArticleFilter('');
		if (renderLibraryContent && next !== section) setVisible(PAGE_SIZE);
		else resetList();
	};
	const renderLibrary = (content: React.ReactNode) => renderLibraryContent ? renderLibraryContent(section, content) : content;
	return <section className="crate-reading crate-reading-workspace" aria-label="Reading" data-reader-open={!!reader} data-reader-motion={readerMotion}>
		<div className="crate-reading__layout">
			<aside className="crate-reading__sidebar" inert={readerMotion !== undefined && (!!reader || readerClosing)}>
				{renderNavigation ? renderNavigation({ items: navigationItems, activeTab: section, onTabChange: selectSection, onAdd, inert: !!reader || readerClosing, disabled: false }) : <NavigationBar className="crate-reading__mobile-nav" items={navigationItems} activeTab={section} onTabChange={selectSection} label="Reading filters" action="switch-reading-section" animateActiveIndicator={animateTabIndicator} />}

			</aside>
			<div className="crate-reading__library" aria-busy={busy.size > 0} inert={readerMotion !== undefined && (!!reader || readerClosing)}>
				{renderLibrary(<>
				<ViewHeader className="crate-reading__header" title={section === 'inbox' ? 'Reading' : readingSections.find(item => item.id === section)!.label} count={count} countUnit={section === 'highlights' ? 'highlight' : 'saved link'} showMeta={!snapshot.loading} reserveMetaSpace rightContent={<div className="crate-view-header-actions">{headerStatus}{onSettings && <IconButton size="large" iconSize="l" icon="settings" label={settingsLabel} onClick={onSettings} />}<IconButton size="large" iconSize="l" className="crate-reading__add" icon="plus" label="Save a link" onClick={onAdd} />{headerActions}</div>} />
				<TextField fieldClassName="crate-reading__search crate-field--rounded" label="Search reading" hideLabel type="search" placeholder={section === 'highlights' ? 'Search highlights and notes' : 'Search your reading'} leadingIcon={<ThemeIcon id="search" size="m" aria-hidden="true" />} value={query} onChange={event => { setQuery(event.target.value); resetList(); }} trailingAction={query && <IconButton size="large" icon="x" label="Clear search" onClick={() => { setQuery(''); resetList(); }} />} />
				{tags.length > 0 && <label className="crate-reading__tag-picker">Tags<select aria-label="Filter by tag" value={tag ?? ''} onChange={event => { setTag(event.target.value || null); resetList(); }}><option value="">All tags</option>{tags.map(value => <option key={value} value={value}>{value}</option>)}</select><ThemeIcon id="chevron-down" size="s" aria-hidden="true" /></label>}
				{section === 'highlights' && <label className="crate-reading__tag-picker">Article<select aria-label="Filter by article" value={articleFilter} onChange={event => { setArticleFilter(event.target.value); resetList(); }}><option value="">All articles</option>{snapshot.items.filter(item => item.highlights?.length).map(item => <option key={item.crate_reading_id} value={item.crate_reading_id}>{item.title}</option>)}</select><ThemeIcon id="chevron-down" size="s" aria-hidden="true" /></label>}
				{beforeListContent}
				<div className="crate-reading__list-scroll" ref={setListRef} tabIndex={-1}>
					{notice}
					{(error || snapshot.error) && <p className="crate-reading__notice" role="alert">{error || snapshot.error} <Button variant="outline" disabled={busy.has('refresh')} onClick={() => run('refresh', onRefresh)}>Refresh</Button></p>}
					{snapshot.issues.length > 0 && <details className="crate-reading__notice"><summary>{snapshot.issues.length} {snapshot.issues.length === 1 ? 'note needs' : 'notes need'} attention</summary><ul>{snapshot.issues.map(issue => <li key={issue.path}><strong>{issue.path}</strong>: {issue.message}</li>)}</ul></details>}
					{tag && <Button variant="outline" className="crate-reading__tag-filter" onClick={() => { setTag(null); resetList(); }}><ThemeIcon id="hash" size="xs" aria-hidden="true" />{tag}<ThemeIcon id="x" size="xs" aria-hidden="true" /><span className="crate-reading__sr-only">Clear tag filter</span></Button>}
					{listContent ?? (snapshot.loading ? <LoadingIndicator label="Loading Reading" /> : <>
						{section === 'highlights' && (count > 0
							? <HighlightList entries={excerpts.slice(0, visible)} onView={(item, highlight) => run('open', () => onOpen(item, highlight, section))} />
							: <EmptyState className="crate-reading__empty" icon="highlighter"
								title={query || articleFilter || tag ? 'No matching highlights' : 'Keep the passages that stay with you'}
								description={query || articleFilter || tag ? 'Try another passage, note, or article.' : 'Select text while reading. Your highlights appear here and in your Obsidian notes.'} />)}
						{section !== 'highlights' && items.length === 0 && <EmptyState className="crate-reading__empty" icon="book-open"
							title={query || tag ? 'No matching links' : section === 'inbox' ? 'Save something worth your time' : section === 'favorites' ? 'Keep your favorites close' : 'A home for what you’ve read'}
							description={query || tag ? 'Try another title, source, or tag.' : section === 'inbox' ? 'An essay, an idea, a little inspiration. Keep it here for a quieter moment.' : section === 'favorites' ? 'Star an article to find it here.' : 'Finished reading? Archive it. You can always come back.'}>
							{section === 'inbox' && !query && !tag && <Button variant="outline" className="crate-reading__text-action" onClick={onAdd}><ThemeIcon id="plus" size="m" aria-hidden="true" />Save your first link</Button>}
						</EmptyState>}
						{section !== 'highlights' && groups.map(group => <section className="crate-reading__group" key={group.label} aria-label={group.label}><h3>{group.label}</h3><ul className="crate-reading__list">{group.items.map(item => <li className="crate-reading__item" key={item.crate_reading_id} data-selected={activeId === item.crate_reading_id}>
							<Button className="crate-reading__open" data-reading-id={item.crate_reading_id} aria-label={`${readingSource(item.source_url)} ${item.title}`} aria-current={activeId === item.crate_reading_id ? 'true' : undefined} aria-disabled={busy.has('open')} onClick={() => run('open', () => onOpen(item, undefined, section))}>
								<ReadingSourceIcon item={item} /><span className="crate-reading__item-copy"><strong>{item.title}</strong><span className="crate-reading__meta">{readingSource(item.source_url)}{item.extraction_status !== 'ready' && <><span aria-hidden="true"> · </span>{item.extraction_status === 'pending' ? 'Text pending' : item.source_url ? 'Link only' : 'Empty note'}</>}</span></span>
							</Button><IconButton size="large" icon="star" className="crate-reading__favorite" label={item.favorite ? 'Remove favorite' : 'Favorite'} aria-pressed={item.favorite} data-filled={item.favorite} disabled={pendingItemIds?.has(item.crate_reading_id)} aria-disabled={busy.has(item.crate_reading_id) || pendingItemIds?.has(item.crate_reading_id)} onClick={() => run(item.crate_reading_id, () => onUpdate(item, { favorite: !item.favorite }))} />
						</li>)}</ul></section>)}
						{visible < count && <Button variant="outline" className="crate-reading__more" onClick={() => setVisible(value => value + PAGE_SIZE)}>Show more</Button>}
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
