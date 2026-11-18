import { useDeferredValue, useMemo } from 'react';
import type { ReadingSnapshot } from '../data/library';
import { countReadingTags, filterReadingHighlights, filterReadingItems, settledHighlights, type ReadingSection } from '../core/reading-presentation';
import { matchesReadingQuery, searchableQuery } from '../core/search-terms';
import { useLibraryPages, type ReadingLibrarySource } from './useLibraryPages';
import { useMinimumLoading } from './useMinimumLoading';
import { LOADING_INDICATOR_DELAY_MS } from '@/ui/shared/LoadingIndicator';

// A loading spinner, once visible, stays at least this long so a quick answer never flickers it.
const MIN_LOADING_MS = 300;

interface ReadingLibraryQuery {
	/** The library shown; with a server `source`, `snapshot` holds only its local state. */
	snapshot: Pick<ReadingSnapshot, 'items' | 'loading'>;
	source?: ReadingLibrarySource;
	section: ReadingSection;
	/** The search as typed. */
	query: string;
	tag: string | null;
	/** Keep the previous section listed until a new section answers, for a switch made on a visible screen. */
	holdPrevious?: boolean;
}

/** What the library lists for one section, search and tag: a local library's matching
 * items, or a server library's matched pages with local changes shown over them. A server
 * library keeps listing the previous search or tag until the new one answers, then changes the
 * list, count and tags together. With `holdPrevious`, another section keeps the previous section listed the
 * same way, so a switch changes screens once its list is ready; otherwise, and when slow, it shows a loading state.
 * The previous list is `pending` while it waits, and a visible spinner stays at least MIN_LOADING_MS. */
export function useReadingLibraryQuery({ snapshot, source, section, query, tag, holdPrevious = false }: ReadingLibraryQuery) {
	// Filter on a deferred query so typing never waits for the list to re-render.
	const deferredQuery = useDeferredValue(query);
	// A server library searches from three characters, so the first letters send no request.
	const listQuery = source ? searchableQuery(deferredQuery) : deferredQuery;
	const pages = useLibraryPages(source, section, listQuery, tag);
	const present = source?.present;
	// A server library lists what its pages answer. Until another section answers, the previous
	// section stays listed, unless it is slow; then the new section shows its loading state.
	const shown = source ? pages.shown : { section, q: listQuery, tag };
	const holding = holdPrevious && !!source && shown.section !== section && pages.answered && !pages.slow;
	const listedSection = holding ? shown.section : section;
	const otherSection = shown.section !== listedSection;
	const loaded = useMemo(() => present ? (otherSection ? [] : present(pages.items)) : snapshot.items, [present, otherSection, pages.items, snapshot.items]);
	const items = useMemo(() => present
		? filterReadingItems(loaded, listedSection, '', null).filter(item => matchesReadingQuery(item, { query: shown.q, tag: shown.tag, highlights: listedSection === 'highlights' }))
		: filterReadingItems(snapshot.items, section, listQuery, tag), [present, loaded, snapshot.items, section, listedSection, listQuery, tag, shown.q, shown.tag]);
	const morePages = !!pages.cursor;
	const excerpts = useMemo(() => {
		const rows = filterReadingHighlights(items, shown.q, !!present);
		return present && listedSection === 'highlights' && morePages ? settledHighlights(rows, pages.items) : rows;
	}, [items, shown.q, present, listedSection, morePages, pages.items]);
	const count = listedSection === 'highlights' ? excerpts.length : items.length;
	// A local library counts its own tags; a server library's arrive with its first page.
	const snapshotItems = snapshot.items;
	const localTags = useMemo(() => source ? [] : countReadingTags(snapshotItems, section), [source, snapshotItems, section]);
	const tags = source ? (otherSection ? [] : pages.tags) : localTags;
	// A loading state that replaced a slow request's dimmed list already waited, so its spinner shows at once.
	const shownLoading = useMinimumLoading(source ? !pages.answered || otherSection || pages.slow : snapshot.loading,
		source && pages.slow ? 0 : LOADING_INDICATOR_DELAY_MS, MIN_LOADING_MS);
	const loading = shownLoading.loading, immediateLoading = shownLoading.appearDelayMs === 0;
	// The list shown answers an earlier section, search or tag while the new one loads.
	const pending = !loading && pages.waiting;
	const more = source ? !!pages.cursor : false;
	return { section: listedSection, listQuery, shownTag: shown.tag, items, excerpts, count, tags, loading, immediateLoading, pending, more, pageLoading: !!source && pages.loading, loadingMore: !!source && pages.loadingMore, pageError: pages.error, loadMore: pages.loadMore };
}
