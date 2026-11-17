import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '../core/model';
import type { ReadingLibrarySource } from './useLibraryPages';
import { useReadingLibraryQuery } from './useReadingLibraryQuery';

const note = (id: string, title: string, tags: string[] = []) =>
	({ crate_reading_id: id, title, tags, reading_status: 'inbox', saved_at: '2026-01-01T00:00:00.000Z', source_url: `https://example.com/${id}` }) as ReadingItem;
const systems = note('systems', 'Systems at scale', ['Work']), cooking = note('cooking', 'Cooking basics', ['Home']);

it('asks a server library from three characters and rechecks its candidates locally', async () => {
	vi.useFakeTimers();
	try {
		// The server matches prefix terms, so its page can hold candidates the title then rejects.
		const load = vi.fn(async () => ({ items: [systems, cooking], cursor: null }));
		const source: ReadingLibrarySource = { load, loadTags: async () => [{ name: 'Server', count: 2 }], revision: 1, present: items => items };
		let query = 'sy';
		const hook = renderHook(() => useReadingLibraryQuery({ snapshot: { items: [], loading: false }, source, section: 'inbox', query, tag: null }));
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ q: '' }));
		expect(hook.current).toMatchObject({ listQuery: '', count: 2, loading: false, more: false });
		query = 'sys';
		hook.rerender();
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'sys' }));
		expect(hook.current.items).toEqual([systems]);
		expect(hook.current.tags).toEqual([{ name: 'Server', count: 2 }]);
	} finally { vi.useRealTimers(); }
});

it('filters a local library without a server, counting its own tags', () => {
	const hook = renderHook(() => useReadingLibraryQuery({ snapshot: { items: [systems, cooking], loading: false }, section: 'inbox', query: 'cook', tag: null }));
	expect(hook.current).toMatchObject({ listQuery: 'cook', items: [cooking], count: 1, loading: false, more: false, pageLoading: false });
	expect(hook.current.tags).toEqual([{ name: 'Home', count: 1 }, { name: 'Work', count: 1 }]);
});

it('keeps the previous tag\'s list and count until the new tag answers, then shows a loading state only when slow', async () => {
	vi.useFakeTimers();
	try {
		let answer: () => void = () => {};
		const load = vi.fn(async ({ tag }: { tag: string | null }) => {
			if (tag) await new Promise<void>(resolve => { answer = resolve; });
			return { items: tag ? [systems] : [systems, cooking], cursor: null };
		});
		const source: ReadingLibrarySource = { load, loadTags: async () => [{ name: 'Work', count: 1 }, { name: 'Home', count: 1 }], revision: 1, present: items => items };
		let tag: string | null = null;
		const hook = renderHook(() => useReadingLibraryQuery({ snapshot: { items: [], loading: false }, source, section: 'inbox', query: '', tag }));
		await act(async () => { await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ count: 2, loading: false });
		tag = 'Work';
		hook.rerender();
		// Before: the list narrowed locally at once, then changed again when the server answered.
		await act(async () => { await vi.advanceTimersByTimeAsync(100); });
		expect(hook.current).toMatchObject({ count: 2, loading: false });
		await act(async () => { await vi.advanceTimersByTimeAsync(400); });
		expect(hook.current.loading).toBe(true);
		await act(async () => { answer(); await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [systems], count: 1, loading: false });
	} finally { vi.useRealTimers(); }
});
