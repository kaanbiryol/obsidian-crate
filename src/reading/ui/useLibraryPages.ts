import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingItem } from '../core/model';
import type { ReadingSection } from '../core/reading-presentation';

/** A host whose library stays on a server: each section, search and tag reads its own pages. */
export interface ReadingLibrarySource {
	load: (query: { section: ReadingSection; q: string; tag: string | null; cursor: string | null }) => Promise<{ items: ReadingItem[]; cursor: string | null }>;
	/** Every tag in the library, for the tag filter. */
	loadTags: () => Promise<string[]>;
	/** Changes whenever the library may have changed, so the loaded pages reload. */
	revision: unknown;
	/** Local changes shown over the server's pages. */
	present: (items: ReadingItem[]) => ReadingItem[];
}

interface Pages { key: string; items: ReadingItem[]; cursor: string | null; loading: boolean; error: string | null; reloading?: boolean }
// Typing waits this long before a search reaches the server.
const SEARCH_DELAY_MS = 250;
// A filtered Highlights page scans a bounded run of notes, so it can come back empty with a
// cursor. Each request follows up to this many more before the list asks again on scroll.
const MAX_EMPTY_FOLLOWS = 3;
// A refresh reads at most this many pages to keep the user's place.
const MAX_RELOAD_PAGES = 20;

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

/** The loaded pages for one section, search and tag; a change starts again from the first page. */
export function useLibraryPages(source: ReadingLibrarySource | undefined, section: ReadingSection, q: string, tag: string | null) {
	const query = q.trim(), key = JSON.stringify([section, query, tag]);
	const [pages, setPages] = useState<Pages>({ key: '', items: [], cursor: null, loading: !!source, error: null });
	const current = useRef(key), latest = useRef(source), shown = useRef(pages), requests = useRef(0);
	current.current = key; latest.current = source; shown.current = pages;
	const enabled = !!source, revision = source?.revision;
	const fetchPage = useCallback(async (cursor: string | null, replace: boolean) => {
		const source = latest.current;
		if (!source) return;
		// Only the latest request applies, so a page answered after a refresh cannot leave a gap.
		const requested = key, request = ++requests.current, stale = () => current.current !== requested || requests.current !== request;
		// A refresh of the shown query reads as many items as it shows, so the list keeps its place.
		const keep = replace && shown.current.key === requested ? shown.current.items.length : 0;
		// A new search or tag keeps the previous items listed until its first page answers.
		// A reload of the shown query runs in the background; only a next page shows its spinner.
		setPages(state => ({ ...state, key: requested, loading: true, error: null, reloading: replace && state.key === requested, ...replace && state.key !== requested ? { cursor: null } : {} }));
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
			if (stale()) return;
			setPages(state => ({ key: requested, items: replace ? state.key === requested ? reuseUnchanged(state.items, items) : items : appendNew(state.items, items), cursor: page.cursor, loading: false, error: null }));
		} catch (cause) {
			if (stale()) return;
			setPages(state => ({ ...state, loading: false, reloading: false, error: cause instanceof Error ? cause.message : 'Your library is unavailable. Retry when connected.' }));
		}
	}, [key, section, query, tag]);
	// A new revision reloads the pages shown.
	useEffect(() => {
		if (!enabled) return;
		const timer = window.setTimeout(() => { void fetchPage(null, true); }, query ? SEARCH_DELAY_MS : 0);
		return () => window.clearTimeout(timer);
	}, [fetchPage, query, enabled, revision]);
	const settled = pages.key === key;
	const loadMore = useCallback(() => { if (settled && pages.cursor && !pages.loading) void fetchPage(pages.cursor, false); }, [fetchPage, settled, pages.cursor, pages.loading]);
	// Until the new search or tag answers, the previous pages stay listed so the caller can
	// narrow them locally instead of blanking the list.
	return { items: pages.items, cursor: settled ? pages.cursor : null, loading: pages.loading || !settled, loadingMore: settled && pages.loading && !pages.reloading,
		error: settled ? pages.error : null, loadMore };
}
