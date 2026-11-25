import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '../core/model';
import { createLibraryPageCache, prefetchLibrarySection, useLibraryPages, type ReadingLibrarySource } from './useLibraryPages';

const item = { crate_reading_id: 'found', title: 'Found' } as ReadingItem;

it('follows a few empty pages that a bounded highlight scan returns, then waits for the next load', async () => {
	vi.useFakeTimers();
	try {
		// Five empty pages with cursors, then a match.
		const load = vi.fn(async ({ cursor }: { cursor: string | null }) => {
			const index = Number(cursor ?? 0);
			return index < 5 ? { items: [], cursor: String(index + 1) } : { items: [item], cursor: null };
		});
		const source: ReadingLibrarySource = { load, loadTags: async () => [], revision: 1, present: items => items };
		const hook = renderHook(() => useLibraryPages(source, 'highlights', 'rare', null));
		await act(async () => { await vi.runAllTimersAsync(); });
		// The first request and three follows, so the list waits after four pages.
		expect(load.mock.calls.map(([query]) => query.cursor)).toEqual([null, '1', '2', '3']);
		expect(hook.current).toMatchObject({ items: [], cursor: '4', loading: false });
		await act(async () => { hook.current.loadMore(); await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [item], cursor: null });
	} finally { vi.useRealTimers(); }
});

it('keeps the previous pages listed while a new search or tag loads', async () => {
	vi.useFakeTimers();
	try {
		const other = { crate_reading_id: 'other', title: 'Other' } as ReadingItem;
		const load = vi.fn(async ({ tag }: { tag: string | null }) => ({ items: tag ? [item] : [item, other], cursor: null }));
		const source: ReadingLibrarySource = { load, loadTags: async () => [], revision: 1, present: items => items };
		let tag: string | null = 'test';
		const hook = renderHook(() => useLibraryPages(source, 'highlights', '', tag));
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [item], loading: false });
		tag = null;
		hook.rerender();
		// The tagged page stays until the untagged one answers, so the list never blanks.
		expect(hook.current).toMatchObject({ items: [item], loading: true });
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [item, other], loading: false });
	} finally { vi.useRealTimers(); }
});

const article = (n: number): ReadingItem => ({ crate_reading_version: 1, crate_reading_id: `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`,
	title: `Article ${n}`, path: `Reading/article-${n}.md`, source_url: 'https://example.test/article',
	saved_at: `2026-10-${String(30 - n).padStart(2, '0')}T12:00:00Z`, reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' });
const titles = (items: ReadingItem[]) => items.map(entry => entry.title);

/** A server of `items` in pages of two, whose responses resolve when the test says. */
function server(items: () => ReadingItem[]) {
	const waiting: Array<() => void> = [];
	const load = vi.fn(async ({ cursor }: { cursor: string | null }) => {
		await new Promise<void>(resolve => waiting.push(resolve));
		const start = cursor ? Number(cursor) : 0, page = items().slice(start, start + 2);
		return { items: page, cursor: start + 2 < items().length ? String(start + 2) : null };
	});
	const settle = async () => { while (waiting.length) await act(async () => { waiting.shift()!(); await Promise.resolve(); }); };
	return { load, settle, release: async (index: number) => act(async () => { waiting.splice(index, 1)[0]!(); }) };
}

function harness(load: ReadingLibrarySource['load']) {
	let revision = 0;
	const hook = renderHook(() => useLibraryPages({ load, loadTags: async () => [], revision, present: items => items }, 'inbox', '', null));
	return { hook, refresh: () => { revision++; hook.rerender(); } };
}

const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

it('keeps the pages a user loaded when the library refreshes', async () => {
	let library = [1, 2, 3, 4, 5].map(article);
	const api = server(() => library);
	const { hook, refresh } = harness(api.load);
	await flush(); await api.settle();
	act(() => hook.current.loadMore()); await api.settle();
	expect(titles(hook.current.items)).toEqual(['Article 1', 'Article 2', 'Article 3', 'Article 4']);
	// An edit removes the first article from this section; the refresh reads as far as the user had.
	// Before: the refresh replaced the list with the first page.
	library = library.slice(1);
	refresh(); await flush(); await api.settle();
	expect(titles(hook.current.items)).toEqual(['Article 2', 'Article 3', 'Article 4', 'Article 5']);
	expect(hook.current.cursor).toBeNull();
});

it('drops a page that arrives after a newer load of the same query', async () => {
	const library = [1, 2, 3, 4, 5, 6].map(article);
	const api = server(() => library);
	const { hook, refresh } = harness(api.load);
	await flush(); await api.settle();
	act(() => hook.current.loadMore());
	refresh(); await flush();
	// The refresh answers first; the older page must not be appended after it with its later cursor.
	await api.release(1); await api.settle();
	expect(titles(hook.current.items)).toEqual(['Article 1', 'Article 2']);
	expect(hook.current.cursor).toBe('2');
});

it('keeps unchanged rows and hides the next-page spinner while a refresh reloads', async () => {
	let library = [1, 2, 3].map(article);
	const api = server(() => library);
	const { hook, refresh } = harness(api.load);
	await flush(); await api.settle();
	const shown = hook.current.items;
	// Returning to the app reloads the shown pages in the background.
	refresh(); await flush();
	expect(hook.current).toMatchObject({ loading: true, loadingMore: false });
	library = library.map(entry => ({ ...entry }));
	await api.settle();
	expect(hook.current.items).toBe(shown);
	// A changed row is replaced; the others keep their objects.
	library = [{ ...library[0]!, title: 'Renamed' }, ...library.slice(1)];
	refresh(); await flush(); await api.settle();
	expect(hook.current.items[0]!.title).toBe('Renamed');
	expect(hook.current.items[1]).toBe(shown[1]);
	// Asking for the next page shows its spinner.
	act(() => hook.current.loadMore()); await flush();
	expect(hook.current.loadingMore).toBe(true);
	await api.settle();
});

it('shows a first page only with its section\'s tags, and returns to a section read since the last revision without asking again', async () => {
	vi.useFakeTimers();
	try {
		const tagAnswers: Array<() => void> = [];
		const load = vi.fn(async ({ section }: { section: string }) => ({ items: section === 'inbox' ? [item] : [], cursor: null }));
		const loadTags = vi.fn(async (section: string) => {
			await new Promise<void>(resolve => tagAnswers.push(resolve));
			return [{ name: section, count: 1 }];
		});
		let section: 'inbox' | 'archived' = 'inbox', revision = 1;
		const hook = renderHook(() => useLibraryPages({ load, loadTags, revision, present: items => items }, section, '', null));
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		// The page answered, but its tags have not: nothing shows yet.
		expect(hook.current).toMatchObject({ items: [], tags: [], loading: true });
		await act(async () => { tagAnswers.shift()!(); await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [item], tags: [{ name: 'inbox', count: 1 }], loading: false });
		section = 'archived';
		hook.rerender();
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		await act(async () => { tagAnswers.shift()!(); await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [], tags: [{ name: 'archived', count: 1 }], shown: { section: 'archived' } });
		section = 'inbox';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [item], tags: [{ name: 'inbox', count: 1 }], loading: false });
		expect(load).toHaveBeenCalledTimes(2);
		expect(loadTags).toHaveBeenCalledTimes(2);
		// A new revision reads the shown section again.
		revision = 2;
		hook.rerender();
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		await act(async () => { tagAnswers.shift()!(); await vi.runAllTimersAsync(); });
		expect(load).toHaveBeenCalledTimes(3);
		expect(loadTags).toHaveBeenCalledTimes(3);
	} finally { vi.useRealTimers(); }
});

it('asks for a section\'s tags again after they failed, rather than keeping none', async () => {
	vi.useFakeTimers();
	try {
		const load = vi.fn(async ({ section }: { section: string }) => ({ items: section === 'archived' ? [item] : [], cursor: null }));
		let failTags = true;
		const loadTags = vi.fn(async (section: string) => {
			if (failTags && section === 'archived') throw new Error('Reading tags response is unreadable.');
			return [{ name: section, count: 1 }];
		});
		let section: 'inbox' | 'archived' = 'archived';
		const hook = renderHook(() => useLibraryPages({ load, loadTags, revision: 1, present: items => items }, section, '', null));
		await act(async () => { await vi.runAllTimersAsync(); });
		// The articles show even though their tags failed.
		expect(hook.current).toMatchObject({ items: [item], tags: [], loading: false });
		failTags = false;
		section = 'inbox';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		section = 'archived';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		// Before: the failure was kept as an empty tag list until the library changed.
		expect(hook.current).toMatchObject({ items: [item], tags: [{ name: 'archived', count: 1 }], loading: false });
		expect(loadTags.mock.calls.filter(([asked]) => asked === 'archived')).toHaveLength(2);
	} finally { vi.useRealTimers(); }
});

it('counts a slow search from when its typing delay sends the request', async () => {
	vi.useFakeTimers();
	try {
		const load = vi.fn(async ({ q }: { q: string }) => {
			if (q) await new Promise<never>(() => {});
			return { items: [item], cursor: null };
		});
		let q = '';
		const hook = renderHook(() => useLibraryPages({ load, loadTags: async () => [], revision: 1, present: items => items }, 'inbox', q, null));
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		q = 'found';
		hook.rerender();
		// The request leaves at 250ms; only an answer slower than 250ms more shows loading.
		await act(async () => { await vi.advanceTimersByTimeAsync(499); });
		expect(hook.current).toMatchObject({ waiting: true, slow: false });
		await act(async () => { await vi.advanceTimersByTimeAsync(1); });
		expect(hook.current).toMatchObject({ waiting: true, slow: true });
	} finally { vi.useRealTimers(); }
});

it('reads a section\'s tags once for every tag and search in it', async () => {
	vi.useFakeTimers();
	try {
		const load = vi.fn(async () => ({ items: [item], cursor: null }));
		const loadTags = vi.fn(async () => [{ name: 'Work', count: 1 }]);
		let tag: string | null = null;
		const hook = renderHook(() => useLibraryPages({ load, loadTags, revision: 1, present: items => items }, 'inbox', '', tag));
		await act(async () => { await vi.runAllTimersAsync(); });
		tag = 'Work';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ shown: { tag: 'Work' }, tags: [{ name: 'Work', count: 1 }] });
		expect(load).toHaveBeenCalledTimes(2);
		expect(loadTags).toHaveBeenCalledTimes(1);
	} finally { vi.useRealTimers(); }
});

it('shows a section read before a new revision at once and reloads it in the background', async () => {
	vi.useFakeTimers();
	try {
		const archived = { crate_reading_id: 'archived', title: 'Archived' } as ReadingItem;
		let archive = [archived];
		const load = vi.fn(async ({ section }: { section: string }) => ({ items: section === 'inbox' ? [item] : archive, cursor: null }));
		const loadTags = vi.fn(async (section: string) => [{ name: section, count: 1 }]);
		let section: 'inbox' | 'archived' = 'inbox', query = '', revision = 1;
		const hook = renderHook(() => useLibraryPages({ load, loadTags, revision, present: items => items }, section, query, null));
		await act(async () => { await vi.runAllTimersAsync(); });
		section = 'archived';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		query = 'arch';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		query = '';
		section = 'inbox';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(load).toHaveBeenCalledTimes(3);
		// A sync changes the library while the inbox is shown.
		archive = [archived, { crate_reading_id: 'new', title: 'New' } as ReadingItem];
		revision = 2;
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(load).toHaveBeenCalledTimes(4);
		section = 'archived';
		hook.rerender();
		// The earlier archive shows without a loading state, then its reload replaces it.
		expect(hook.current).toMatchObject({ items: [archived], tags: [{ name: 'archived', count: 1 }], shown: { section: 'archived' }, loading: false });
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(hook.current.items.map(entry => entry.crate_reading_id)).toEqual(['archived', 'new']);
		expect(load).toHaveBeenCalledTimes(5);
		expect(loadTags).toHaveBeenCalledTimes(4);
		// A search from before the sync is read again rather than shown from memory.
		query = 'arch';
		hook.rerender();
		expect(hook.current).toMatchObject({ shown: { q: '' }, loading: true });
	} finally { vi.useRealTimers(); }
});

it('never renders a loading state when returning to a section read before', async () => {
	vi.useFakeTimers();
	try {
		const load = vi.fn(async ({ section }: { section: string }) => ({ items: section === 'inbox' ? [item] : [], cursor: null }));
		let section: 'inbox' | 'archived' = 'inbox';
		const renders: Array<{ section: string; loading: boolean }> = [];
		const hook = renderHook(() => {
			const pages = useLibraryPages({ load, loadTags: async () => [], revision: 1, present: items => items }, section, '', null);
			renders.push({ section: pages.shown.section, loading: pages.loading });
			return pages;
		});
		await act(async () => { await vi.runAllTimersAsync(); });
		section = 'archived';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		renders.length = 0;
		section = 'inbox';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(renders.length).toBeGreaterThan(0);
		expect(renders).toEqual(renders.map(() => ({ section: 'inbox', loading: false })));
		expect(load).toHaveBeenCalledTimes(2);
	} finally { vi.useRealTimers(); }
});

it('shows a prefetched section at once and reloads it only for a new revision', async () => {
	const load = vi.fn(async () => ({ items: [item], cursor: null }));
	const loadTags = vi.fn(async () => [{ name: 'tag', count: 1 }]);
	const cache = createLibraryPageCache();
	let revision = 1;
	const source = () => ({ load, loadTags, revision, present: (items: ReadingItem[]) => items, cache });
	await prefetchLibrarySection(source(), 'favorites');
	// A second prefetch finds the section and asks nothing.
	await prefetchLibrarySection(source(), 'favorites');
	expect(load).toHaveBeenCalledTimes(1);
	expect(loadTags).toHaveBeenCalledTimes(1);
	const hook = renderHook(() => useLibraryPages(source(), 'favorites', '', null));
	// The list mounts with the prefetched page instead of a loading state.
	expect(hook.current).toMatchObject({ items: [item], loading: false, answered: true });
	await flush();
	expect(load).toHaveBeenCalledTimes(1);
	// A new library keeps the page on screen while it reloads.
	revision = 2;
	hook.rerender();
	expect(hook.current.items).toEqual([item]);
	await flush();
	expect(load).toHaveBeenCalledTimes(2);
});

it('keeps pages the list read while a prefetch was answering', async () => {
	const cache = createLibraryPageCache();
	let answer!: () => void;
	const slow = vi.fn(() => new Promise<{ items: ReadingItem[]; cursor: string | null }>(resolve => { answer = () => resolve({ items: [], cursor: null }); }));
	const prefetch = prefetchLibrarySection({ load: slow, loadTags: async () => [], revision: 1, present: items => items, cache }, 'archived');
	const read = { crate_reading_id: 'read', title: 'Read' } as ReadingItem;
	const hook = renderHook(() => useLibraryPages({ load: async () => ({ items: [read], cursor: null }), loadTags: async () => [], revision: 1, present: items => items, cache }, 'archived', '', null));
	await flush();
	answer();
	await prefetch;
	expect(cache.pages.get(JSON.stringify(['archived', '', null]))?.items).toEqual([read]);
	expect(hook.current.items).toEqual([read]);
});

it('applies a refresh\'s changes to the loaded pages without reading them again', async () => {
	const library = [1, 2, 3, 4, 5].map(article);
	const api = server(() => library);
	const loadTags = vi.fn(async () => []);
	let source: ReadingLibrarySource = { load: api.load, loadTags, revision: {}, at: '0.1', present: items => items };
	const hook = renderHook(() => useLibraryPages(source, 'inbox', '', null));
	await flush(); await api.settle();
	act(() => hook.current.loadMore()); await api.settle();
	expect(titles(hook.current.items)).toEqual(['Article 1', 'Article 2', 'Article 3', 'Article 4']);
	const reads = api.load.mock.calls.length, tagReads = loadTags.mock.calls.length;
	// Article 2 was archived and article 3 renamed elsewhere; the refresh brings only those.
	source = { ...source, revision: {}, at: '0.2', changes: { from: '0.1', to: '0.2', items: [{ ...library[1]!, reading_status: 'archived' }, { ...library[2]!, title: 'Renamed' }], removed: [] } };
	hook.rerender(); await flush();
	expect(titles(hook.current.items)).toEqual(['Article 1', 'Renamed', 'Article 4']);
	// Before: the refresh read every loaded page again, up to 20 of them.
	expect(api.load.mock.calls.length).toBe(reads);
	expect(loadTags.mock.calls.length).toBe(tagReads + 1);
	// Changes from another revision than the pages answer for reload them, as before.
	source = { ...source, revision: {}, at: '0.4', changes: { from: '0.3', to: '0.4', items: [], removed: [] } };
	hook.rerender(); await flush(); await api.settle();
	expect(api.load.mock.calls.length).toBeGreaterThan(reads);
});

it('cancels a search typed past instead of letting it finish', async () => {
	vi.useFakeTimers();
	try {
		const signals = new Map<string, AbortSignal>();
		const load = vi.fn(({ q }: { q: string }, signal?: AbortSignal) => {
			signals.set(q, signal!);
			return new Promise<{ items: ReadingItem[]; cursor: string | null }>(resolve => { setTimeout(() => resolve({ items: [item], cursor: null }), 5_000); });
		});
		const source: ReadingLibrarySource = { load, loadTags: async () => [], revision: 1, present: items => items };
		let q = 'rea';
		const hook = renderHook(() => useLibraryPages(source, 'inbox', q, null));
		await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
		expect(signals.get('rea')?.aborted).toBe(false);
		q = 'read';
		hook.rerender();
		expect(signals.get('rea')!.aborted).toBe(true);
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(signals.get('read')!.aborted).toBe(false);
		expect(hook.current).toMatchObject({ items: [item], loading: false });
	} finally { vi.useRealTimers(); }
});
