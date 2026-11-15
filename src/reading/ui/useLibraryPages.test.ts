import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '../core/model';
import { useLibraryPages, type ReadingLibrarySource } from './useLibraryPages';

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
