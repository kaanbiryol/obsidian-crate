import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Hash, Plus, Search, X } from 'lucide-react';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { ToggleButton } from '../../ui/shared/ToggleButton';
import { ViewHeader } from '../../ui/shared/ViewHeader';
import { NavigationBar } from '../../ui/shared/NavigationBar';
import { ThemeIcon } from '../../reminders/components/theme-icon';
import { FloatingActionButton } from '../../reminders/components/FloatingActionButton';
import type { ReadingChanges, ReadingItem } from '../core/model';
import type { ReadingSnapshot } from '../data/library';
import { filterReadingItems, groupReadingItems, readingSections, readingSource, type ReadingSection } from './reading-presentation';

export interface ReadingLibraryProps {
	snapshot: ReadingSnapshot;
	onAdd: () => void;
	onOpen: (item: ReadingItem) => Promise<void>;
	onUpdate: (item: ReadingItem, changes: ReadingChanges) => Promise<void>;
	onRefresh: () => Promise<void>;
	onSettings?: () => void;
	headerActions?: React.ReactNode;
	activeId?: string;
	reader?: React.ReactNode;
	notice?: React.ReactNode;
}

const sectionIcons = { inbox: 'inbox', favorites: 'star', archived: 'archive' };
const navigationItems = readingSections.map(item => ({ ...item, iconName: sectionIcons[item.id] }));
const PAGE_SIZE = 100;

/** Shared workspace. Its container width, rather than the host viewport, chooses the layout. */
export function ReadingLibraryPanel({ snapshot, onAdd, onOpen, onUpdate, onRefresh, onSettings, headerActions, activeId, reader, notice }: ReadingLibraryProps) {
	const [section, setSection] = useState<ReadingSection>('inbox');
	const [query, setQuery] = useState(''), [tag, setTag] = useState<string | null>(null);
	const [visible, setVisible] = useState(PAGE_SIZE);
	const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
	const pending = useRef(false), list = useRef<HTMLDivElement>(null);
	const previousArticle = useRef(activeId);
	useEffect(() => {
		if (!activeId && previousArticle.current) {
			const button = list.current?.querySelector<HTMLButtonElement>(`[data-reading-id="${previousArticle.current}"]`);
			(button ?? list.current)?.focus({ preventScroll: true });
		}
		previousArticle.current = activeId;
	}, [activeId]);
	const items = useMemo(() => filterReadingItems(snapshot.items, section, query, tag), [snapshot.items, section, query, tag]);
	const groups = useMemo(() => groupReadingItems(items.slice(0, visible)), [items, visible]);
	const tags = useMemo(() => [...new Set(snapshot.items.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b)), [snapshot.items]);
	const run = (key: string, action: () => Promise<void>) => {
		if (pending.current) return;
		pending.current = true; setBusy(key); setError(null);
		void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not update reading.'))
			.finally(() => { pending.current = false; setBusy(null); });
	};
	const resetList = () => { setVisible(PAGE_SIZE); list.current?.scrollTo({ top: 0 }); };
	const selectSection = (next: ReadingSection) => { setSection(next); setTag(null); resetList(); };
	return <section className="crate-reading crate-reading-workspace" aria-label="Reading" data-reader-open={!!reader}>
		<div className="crate-reading__layout">
			<aside className="crate-reading__sidebar">
				<div className="crate-reading__brand"><BookOpen size={21} strokeWidth={1.6} aria-hidden="true" /><span>Reading</span><span className="crate-reading__byline">by Crate</span></div>
				<nav className="crate-reading__tabs" aria-label="Reading filters">
					{readingSections.map(({ id, label }) => {
						const count = snapshot.items.filter(item => id === 'favorites' ? item.favorite : item.reading_status === id).length;
						return <ToggleButton key={id} aria-label={label} pressed={section === id} onPressedChange={() => selectSection(id)}><ThemeIcon id={sectionIcons[id]} size="l" aria-hidden="true" /><span>{label}</span><span className="crate-reading__nav-count" aria-hidden="true">{count || ''}</span></ToggleButton>;
					})}
				</nav>
				<NavigationBar className="crate-reading__mobile-nav" items={navigationItems} activeTab={section} onTabChange={selectSection} label="Reading filters" action="switch-reading-section" />
				{tags.length > 0 && <div className="crate-reading__tag-nav"><h2>Tags</h2>{tags.map(value => <Button key={value} aria-pressed={tag === value} onClick={() => { setTag(tag === value ? null : value); resetList(); }}><Hash size={17} aria-hidden="true" /><span>{value}</span></Button>)}</div>}
				<div className="crate-reading__sidebar-bottom"><BookOpen size={16} aria-hidden="true" /><span>A little space to read.</span></div>
			</aside>
			<div className="crate-reading__library" aria-busy={!!busy}>
				<ViewHeader className="crate-reading__header" title={section === 'inbox' ? 'Reading' : readingSections.find(item => item.id === section)!.label} count={items.length} countUnit="saved link" showMeta={!snapshot.loading} reserveMetaSpace rightContent={<div className="crate-view-header-actions">{headerActions}{onSettings && <IconButton size="large" iconSize="l" icon="settings" label="Reading settings" onClick={onSettings} />}<IconButton size="large" iconSize="l" className="crate-reading__add" icon="plus" label="Save a link" disabled={!!busy} onClick={onAdd} /></div>} />
				<label className="crate-reading__search"><Search size={18} aria-hidden="true" /><input type="search" placeholder="Search your reading" aria-label="Search reading" value={query} onChange={event => { setQuery(event.target.value); resetList(); }} />{query && <IconButton size="large" icon="x" label="Clear search" onClick={() => { setQuery(''); resetList(); }} />}</label>
				<div className="crate-reading__list-scroll" ref={list} tabIndex={-1}>
					{notice}
					{(error || snapshot.error) && <p className="crate-reading__notice" role="alert">{error || snapshot.error} <Button variant="outline" disabled={!!busy} onClick={() => run('refresh', onRefresh)}>Refresh</Button></p>}
					{snapshot.issues.length > 0 && <details className="crate-reading__notice"><summary>{snapshot.issues.length} {snapshot.issues.length === 1 ? 'note needs' : 'notes need'} attention</summary><ul>{snapshot.issues.map(issue => <li key={issue.path}><strong>{issue.path}</strong>: {issue.message}</li>)}</ul></details>}
					{tag && <Button variant="outline" className="crate-reading__tag-filter" onClick={() => { setTag(null); resetList(); }}><Hash size={14} />{tag}<X size={14} /><span className="crate-reading__sr-only">Clear tag filter</span></Button>}
					{snapshot.loading ? <div className="crate-reading__loading" role="status"><span>Loading your reading…</span>{[0, 1, 2, 3].map(i => <div key={i} aria-hidden="true" />)}</div> : <>
						{items.length === 0 && <div className="crate-reading__empty"><BookOpen size={36} strokeWidth={1.3} aria-hidden="true" /><h2>{query || tag ? 'No matching links' : section === 'inbox' ? 'Save something worth your time' : section === 'favorites' ? 'Keep your favorites close' : 'A home for what you’ve read'}</h2><p>{query || tag ? 'Try another title, source, or tag.' : section === 'inbox' ? 'An essay, an idea, a little inspiration. Keep it here for a quieter moment.' : section === 'favorites' ? 'Star an article to find it here.' : 'Finished reading? Archive it. You can always come back.'}</p>{section === 'inbox' && !query && !tag && <Button variant="outline" className="crate-reading__text-action" onClick={onAdd}><Plus size={17} />Save your first link</Button>}</div>}
						{groups.map(group => <section className="crate-reading__group" key={group.label} aria-label={group.label}><h3>{group.label}</h3><ul className="crate-reading__list">{group.items.map(item => <li className="crate-reading__item" key={item.crate_reading_id} data-selected={activeId === item.crate_reading_id}>
							<Button className="crate-reading__open" data-reading-id={item.crate_reading_id} aria-label={`${readingSource(item.source_url)} ${item.title}`} aria-current={activeId === item.crate_reading_id ? 'true' : undefined} disabled={!!busy} onClick={() => run(item.crate_reading_id, () => onOpen(item))}>
								<span className="crate-reading__source-icon" aria-hidden="true">{readingSource(item.source_url).slice(0, 1).toUpperCase()}</span><span className="crate-reading__item-copy"><strong>{item.title}</strong><span className="crate-reading__meta">{readingSource(item.source_url)}{item.extraction_status !== 'ready' && <><span aria-hidden="true"> · </span>{item.extraction_status === 'pending' ? 'Text pending' : 'Link only'}</>}</span></span>
							</Button><IconButton size="large" icon="star" className="crate-reading__favorite" label={item.favorite ? 'Remove favorite' : 'Favorite'} aria-pressed={item.favorite} data-filled={item.favorite} disabled={!!busy} onClick={() => run(item.crate_reading_id, () => onUpdate(item, { favorite: !item.favorite }))} />
						</li>)}</ul></section>)}
						{visible < items.length && <Button variant="outline" className="crate-reading__more" onClick={() => setVisible(value => value + PAGE_SIZE)}>Show more</Button>}
					</>}
				</div>
				<FloatingActionButton className="crate-reading__mobile-add" aria-label="Save a link" disabled={!!busy} onClick={onAdd} animateOnMount={false} />
			</div>
			<div className="crate-reading__reader-pane">{reader ?? <div className="crate-reading__reader-empty"><BookOpen size={42} strokeWidth={1.2} aria-hidden="true" /><h2>Make time for a good read.</h2><p>Pick something from your library.<br />Everything else can wait a moment.</p></div>}</div>
		</div>
	</section>;
}
