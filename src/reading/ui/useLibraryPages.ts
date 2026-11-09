import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingItem } from '../core/model';
import type { ReadingSection } from '../core/reading-presentation';

/** A host whose library stays on a server: each section, search and tag reads its own pages. */
export interface ReadingLibrarySource {
	load: (query: { section: ReadingSection; q: string; tag: string | null; cursor: string | null }) => Promise<{ items: ReadingItem[]; cursor: string | null }>;
	/** Changes whenever the library may have changed, so the loaded pages reload. */
	revision: unknown;
	/** Local changes shown over the server's pages. */
	present: (items: ReadingItem[]) => ReadingItem[];
}

interface Pages { key: string; items: ReadingItem[]; cursor: string | null; loading: boolean; error: string | null }
// Typing waits this long before a search reaches the server.
const SEARCH_DELAY_MS = 250;

/** The loaded pages for one section, search and tag; a change starts again from the first page. */
export function useLibraryPages(source: ReadingLibrarySource | undefined, section: ReadingSection, q: string, tag: string | null) {
	const query = q.trim(), key = JSON.stringify([section, query, tag]);
	const [pages, setPages] = useState<Pages>({ key: '', items: [], cursor: null, loading: !!source, error: null });
	const current = useRef(key), latest = useRef(source);
	current.current = key; latest.current = source;
	const enabled = !!source, revision = source?.revision;
	const fetchPage = useCallback(async (cursor: string | null, replace: boolean) => {
		const source = latest.current;
		if (!source) return;
		const requested = key;
		setPages(state => ({ ...state, key: requested, loading: true, error: null, ...replace && state.key !== requested ? { items: [], cursor: null } : {} }));
		try {
			const page = await source.load({ section, q: query, tag, cursor });
			if (current.current !== requested) return;
			setPages(state => ({ key: requested, items: replace ? page.items : [...state.items, ...page.items.filter(item => !state.items.some(other => other.crate_reading_id === item.crate_reading_id))],
				cursor: page.cursor, loading: false, error: null }));
		} catch (cause) {
			if (current.current !== requested) return;
			setPages(state => ({ ...state, loading: false, error: cause instanceof Error ? cause.message : 'Your library is unavailable. Retry when connected.' }));
		}
	}, [key, section, query, tag]);
	// A new revision reloads the first page.
	useEffect(() => {
		if (!enabled) return;
		const timer = window.setTimeout(() => { void fetchPage(null, true); }, query ? SEARCH_DELAY_MS : 0);
		return () => window.clearTimeout(timer);
	}, [fetchPage, query, enabled, revision]);
	const loadMore = useCallback(() => { if (pages.cursor && !pages.loading) void fetchPage(pages.cursor, false); }, [fetchPage, pages.cursor, pages.loading]);
	const settled = pages.key === key;
	return { items: settled ? pages.items : [], cursor: settled ? pages.cursor : null, loading: pages.loading || !settled, error: settled ? pages.error : null, loadMore };
}
