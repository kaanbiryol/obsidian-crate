import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingItem } from '../core/model';
import type { ReadingSection, ReadingTag } from '../core/reading-presentation';

/** A host whose library stays on a server: each section, search and tag reads its own pages. */
export interface ReadingLibrarySource {
	load: (query: { section: ReadingSection; q: string; tag: string | null; cursor: string | null }) => Promise<{ items: ReadingItem[]; cursor: string | null }>;
	/** The tags of one section's notes, for the tag filter. */
	loadTags: (section: ReadingSection) => Promise<ReadingTag[]>;
	/** Changes whenever the library may have changed, so the loaded pages reload. */
	revision: unknown;
	/** Local changes shown over the server's pages. */
	present: (items: ReadingItem[]) => ReadingItem[];
}

/** The query that `items` and `tags` answer, which trails the asked query until it loads. */
interface ShownLibraryQuery { section: ReadingSection; q: string; tag: string | null }
interface Pages extends ShownLibraryQuery { key: string; items: ReadingItem[]; cursor: string | null; tags: ReadingTag[]; loading: boolean; error: string | null; reloading?: boolean }
interface Cached { items: ReadingItem[]; cursor: string | null }
interface Cache { revision: unknown; pages: Map<string, Cached>; tags: Map<ReadingSection, ReadingTag[]> }
// Typing waits this long before a search reaches the server.
const SEARCH_DELAY_MS = 250;
// A filtered Highlights page scans a bounded run of notes, so it can come back empty with a
// cursor. Each request follows up to this many more before the list asks again on scroll.
const MAX_EMPTY_FOLLOWS = 3;
// A refresh reads at most this many pages to keep the user's place.
const MAX_RELOAD_PAGES = 20;
// A new query that takes longer than this shows a loading state instead of the previous list.
const SLOW_LIBRARY_QUERY_MS = 400;

const appendNew = (items: ReadingItem[], more: ReadingItem[]) => [...items, ...more.filter(item => !items.some(other => other.crate_reading_id === item.crate_reading_id))];

/** A reload's items, reusing the shown objects (and array) that did not change so rows keep their identity. */
function reuseUnchanged(shown: ReadingItem[], next: ReadingItem[]): ReadingItem[] {
	const byId = new Map(shown.map(item => [item.crate_reading_id, item]));
	let changed = shown.length !== next.length;
	const items = next.map((item, index) => {
		const previous = byId.get(item.crate_reading_id);
		const kept = previous && JSON.stringify(previous) === JSON.stringify(item) ? previous : item;
		if (kept !== shown[index]) changed = true;
		return kept;
	});
	return changed ? items : shown;
}

/** The loaded pages for one section, search and tag; a change starts again from the first page.
 * A new query keeps the previous pages, their tags and their query until its first page and its
 * section's tags both answer, so the list, count and tags change together. Pages and tags read
 * since the last `revision` are kept, so returning to them shows them without asking again. */
export function useLibraryPages(source: ReadingLibrarySource | undefined, section: ReadingSection, q: string, tag: string | null) {
	const query = q.trim(), key = JSON.stringify([section, query, tag]);
	const [pages, setPages] = useState<Pages>({ key: '', section, q: query, tag, items: [], cursor: null, tags: [], loading: !!source, error: null });
	const current = useRef(key), latest = useRef(source), shown = useRef(pages), requests = useRef(0);
	current.current = key; latest.current = source; shown.current = pages;
	const enabled = !!source, revision = source?.revision;
	const cache = useRef<Cache>({ revision: undefined, pages: new Map(), tags: new Map() });
	if (cache.current.revision !== revision) cache.current = { revision, pages: new Map(), tags: new Map() };
	const fetchPage = useCallback(async (cursor: string | null, replace: boolean) => {
		const source = latest.current, saved = cache.current;
		if (!source) return;
		// Only the latest request applies, so a page answered after a refresh cannot leave a gap.
		const requested = key, request = ++requests.current, stale = () => current.current !== requested || requests.current !== request;
		// A refresh of the shown query reads as many items as it shows, so the list keeps its place.
		const keep = replace && shown.current.key === requested ? shown.current.items.length : 0;
		// A reload of the shown query runs in the background; only a next page shows its spinner.
		setPages(state => ({ ...state, loading: true, error: null, reloading: replace && state.key === requested }));
		// A first page also reads its section's tags, unless they were read since the last revision.
		const knownTags = saved.tags.get(section);
		const tags = replace && !knownTags ? source.loadTags(section).catch(() => shown.current.section === section ? shown.current.tags : []) : Promise.resolve(knownTags ?? shown.current.tags);
		try {
			let page = await source.load({ section, q: query, tag, cursor }), items = page.items;
			for (let follows = 0; !page.items.length && page.cursor && follows < MAX_EMPTY_FOLLOWS && !stale(); follows++) {
				page = await source.load({ section, q: query, tag, cursor: page.cursor });
				items = page.items;
			}
			for (let read = 1; replace && page.cursor && items.length < keep && read < MAX_RELOAD_PAGES && !stale(); read++) {
				page = await source.load({ section, q: query, tag, cursor: page.cursor });
				items = appendNew(items, page.items);
			}
			const sectionTags = await tags;
			if (stale()) return;
			const previous = shown.current;
			const listed = !replace ? appendNew(previous.items, items) : previous.key === requested ? reuseUnchanged(previous.items, items) : items;
			// Unchanged tags keep the shown row.
			const kept = previous.section === section && JSON.stringify(previous.tags) === JSON.stringify(sectionTags) ? previous.tags : sectionTags;
			saved.pages.set(requested, { items: listed, cursor: page.cursor });
			if (replace) saved.tags.set(section, kept);
			setPages({ key: requested, section, q: query, tag, items: listed, cursor: page.cursor, tags: kept, loading: false, error: null });
		} catch (cause) {
			if (stale()) return;
			const error = cause instanceof Error ? cause.message : 'Your library is unavailable. Retry when connected.';
			// A failed new query shows its error in place of the previous query's list.
			setPages(state => state.key === requested ? { ...state, loading: false, reloading: false, error }
				: { key: requested, section, q: query, tag, items: [], cursor: null, tags: state.section === section ? state.tags : [], loading: false, error });
		}
	}, [key, section, query, tag]);
	useEffect(() => {
		if (!enabled) return;
		// A query read since the last revision shows at once, without asking the server again.
		const known = cache.current.pages.get(key), knownTags = cache.current.tags.get(section);
		if (known && knownTags) {
			if (shown.current.key !== key) setPages({ key, section, q: query, tag, ...known, tags: knownTags, loading: false, error: null });
			return;
		}
		const timer = window.setTimeout(() => { void fetchPage(null, true); }, query ? SEARCH_DELAY_MS : 0);
		return () => window.clearTimeout(timer);
	}, [fetchPage, key, section, query, tag, enabled, revision]);
	const settled = pages.key === key;
	// A wait past SLOW_LIBRARY_QUERY_MS shows a loading state rather than the previous query.
	const [slowKey, setSlowKey] = useState<string | null>(null);
	useEffect(() => {
		if (settled) return;
		const timer = window.setTimeout(() => setSlowKey(key), SLOW_LIBRARY_QUERY_MS);
		return () => window.clearTimeout(timer);
	}, [settled, key]);
	const loadMore = useCallback(() => { if (settled && pages.cursor && !pages.loading) void fetchPage(pages.cursor, false); }, [fetchPage, settled, pages.cursor, pages.loading]);
	return { items: pages.items, shown: { section: pages.section, q: pages.q, tag: pages.tag }, tags: pages.tags,
		cursor: settled ? pages.cursor : null, loading: pages.loading || !settled, loadingMore: settled && pages.loading && !pages.reloading,
		slow: !settled && slowKey === key, error: settled ? pages.error : null, loadMore };
}
