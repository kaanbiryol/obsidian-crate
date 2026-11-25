import { useEffect, useMemo, useRef } from 'react';
import { createLibraryPageCache, prefetchLibrarySection, type LibraryPageCache, type ReadingLibrarySource } from '@/reading/ui/useLibraryPages';
import type { ReadingSection } from '@/reading/core/reading-presentation';
import type { ReadingItem } from '@/reading/core/model';
import type { ReadingLibraryChanges } from '@/reading/ui/library-changes';
import type { DockTab } from '../settings/dock-preferences';
import { queryReadingItems, queryReadingTags } from './api';
import { presentReadingItems } from './pending-view';
import type { PendingReading } from './outbox';
import type { ReadingSession } from './session/session';

interface Library { items: ReadingItem[]; cursor?: string | null; offline?: boolean; revision?: string; changes?: ReadingLibraryChanges }

const DOCK_SECTIONS: Partial<Record<DockTab, ReadingSection>> = { reading: 'inbox', favorites: 'favorites', archive: 'archived', highlights: 'highlights' };

/** The Reading sections the user put in the dock, in dock order. */
export const dockReadingSections = (tabs: readonly DockTab[]): ReadingSection[] => tabs.flatMap(tab => DOCK_SECTIONS[tab] ?? []);

/** The server's library pages for the Reading list. Owned by the runtime, so its cache outlives the
 * list and the dock's Reading sections load before the user first opens them. */
export function useReadingLibrarySource({ session, savedOnly, library, pending, dockTabs }: {
	session: ReadingSession | null; savedOnly: boolean; library: Library | null; pending: PendingReading[]; dockTabs: readonly DockTab[];
}): ReadingLibrarySource | undefined {
	// Another session's pages never show in this one.
	const identity = session && JSON.stringify([session.id, session.generation]);
	const owned = useRef<{ identity: string | null; cache: LibraryPageCache }>({ identity, cache: createLibraryPageCache() });
	if (owned.current.identity !== identity) owned.current = { identity, cache: createLibraryPageCache() };
	const cache = owned.current.cache;
	const source = useMemo<ReadingLibrarySource | undefined>(() => session && !savedOnly && library ? {
		load: async ({ section, q, tag, cursor }, signal) => {
			// The sync just read the first inbox page; the library shows it without asking again.
			if (section === 'inbox' && !q.trim() && !tag && !cursor) return { items: library.items, cursor: library.cursor ?? null };
			const page = await queryReadingItems(session, { section, q, tag: tag ?? undefined, cursor: cursor ?? undefined }, signal);
			return { items: page.items, cursor: page.cursor };
		},
		loadTags: section => queryReadingTags(session, section),
		revision: library, at: library.revision, changes: library.changes, present: items => presentReadingItems(items, pending), cache,
	} : undefined, [session, savedOnly, library, pending, cache]);
	const sections = dockReadingSections(dockTabs).join();
	// Only a source for a new library starts a prefetch; `pending` changes rebuild it in between.
	const latest = useRef(source);
	latest.current = source;
	const ready = !!source;
	useEffect(() => {
		if (!ready || !sections) return;
		let cancelled = false;
		const prefetch = async () => {
			const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
			if (cancelled || !navigator.onLine || connection?.saveData || document.visibilityState !== 'visible') return;
			// One section at a time, so the opening screen's own requests go first.
			for (const section of sections.split(',') as ReadingSection[]) {
				const current = latest.current;
				if (cancelled || !current) return;
				// A failed prefetch leaves the section to load when it opens.
				await prefetchLibrarySection(current, section).catch(() => undefined);
			}
		};
		// Let the opening screen paint and load first.
		if (typeof window.requestIdleCallback === 'function') {
			const id = window.requestIdleCallback(() => void prefetch(), { timeout: 3000 });
			return () => { cancelled = true; window.cancelIdleCallback(id); };
		}
		const id = window.setTimeout(() => void prefetch(), 1000);
		return () => { cancelled = true; window.clearTimeout(id); };
	}, [ready, sections, cache]);
	return source;
}
