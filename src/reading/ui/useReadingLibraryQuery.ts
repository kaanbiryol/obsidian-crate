import { useCallback, useDeferredValue, useMemo } from 'react';
import type { ReadingSnapshot } from '../data/library';
import { filterReadingHighlights, filterReadingItems, settledHighlights, type ReadingSection } from '../core/reading-presentation';
import { matchesReadingQuery, searchableQuery } from '../core/search-terms';
import { useLibraryPages, type ReadingLibrarySource } from './useLibraryPages';

interface ReadingLibraryQuery {
	/** The library shown; with a server `source`, `snapshot` holds only its local state. */
	snapshot: Pick<ReadingSnapshot, 'items' | 'loading'>;
	source?: ReadingLibrarySource;
	section: ReadingSection;
	/** The search as typed. */
	query: string;
	tag: string | null;
}

/** What the library lists for one section, search and tag: a local library's matching
 * items, or a server library's matched pages with local changes shown over them. */
export function useReadingLibraryQuery({ snapshot, source, section, query, tag }: ReadingLibraryQuery) {
	// Filter on a deferred query so typing never waits for the list to re-render.
	const deferredQuery = useDeferredValue(query);
	// A server library searches from three characters, so the first letters send no request.
	const listQuery = source ? searchableQuery(deferredQuery) : deferredQuery;
	// A server library lists pages the server matched; local changes then move or hide items.
	const pages = useLibraryPages(source, section, listQuery, tag);
	const present = source?.present;
	const loaded = useMemo(() => present ? present(pages.items) : snapshot.items, [present, pages.items, snapshot.items]);
	const items = useMemo(() => present
		? filterReadingItems(loaded, section, '', null).filter(item => matchesReadingQuery(item, { query: listQuery, tag, highlights: section === 'highlights' }))
		: filterReadingItems(snapshot.items, section, listQuery, tag), [present, loaded, snapshot.items, section, listQuery, tag]);
	const morePages = !!pages.cursor;
	const excerpts = useMemo(() => {
		const rows = filterReadingHighlights(items, listQuery, !!present);
		return present && section === 'highlights' && morePages ? settledHighlights(rows, pages.items) : rows;
	}, [items, listQuery, present, section, morePages, pages.items]);
	const count = section === 'highlights' ? excerpts.length : items.length;
	// A server library lists every tag; a local one holds them all already.
	const snapshotItems = snapshot.items;
	const loadLocalTags = useCallback(async () => [...new Set(snapshotItems.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b)), [snapshotItems]);
	const loadTags = source?.loadTags ?? loadLocalTags;
	// Previous results narrowed to the new filter stay up while the server answers; only an
	// empty narrowing waits on the (delayed) spinner rather than flashing the empty state.
	const loading = source ? pages.loading && count === 0 : snapshot.loading;
	const more = source ? !!pages.cursor : false;
	return { listQuery, items, excerpts, count, loadTags, loading, more, pageLoading: !!source && pages.loading, pageError: pages.error, loadMore: pages.loadMore };
}
