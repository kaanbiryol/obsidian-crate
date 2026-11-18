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
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
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
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		expect(hook.current).toMatchObject({ count: 2, loading: false });
		tag = 'Work';
		hook.rerender();
		// Before: the list narrowed locally at once, then changed again when the server answered.
		// The previous list shows pending at once, so the tap reads as taken.
		await act(async () => { await vi.advanceTimersByTimeAsync(100); });
		expect(hook.current).toMatchObject({ count: 2, loading: false, pending: true });
		// The dimmed list already waited, so the spinner shows at once.
		await act(async () => { await vi.advanceTimersByTimeAsync(150); });
		expect(hook.current).toMatchObject({ loading: true, immediateLoading: true, pending: false });
		// Once shown, the spinner stays 300ms even though the tag answers sooner.
		await act(async () => { await vi.advanceTimersByTimeAsync(100); });
		await act(async () => { answer(); await vi.advanceTimersByTimeAsync(0); });
		expect(hook.current).toMatchObject({ count: 1, loading: true });
		await act(async () => { await vi.advanceTimersByTimeAsync(200); });
		expect(hook.current).toMatchObject({ items: [systems], count: 1, loading: false, pending: false });
	} finally { vi.useRealTimers(); }
});

it('shows a loading state, not an empty library, until a server library\'s first page answers', async () => {
	vi.useFakeTimers();
	try {
		let answer: () => void = () => {};
		const load = vi.fn(async () => {
			await new Promise<void>(resolve => { answer = resolve; });
			return { items: [systems], cursor: null };
		});
		const source: ReadingLibrarySource = { load, loadTags: async () => [], revision: 1, present: items => items };
		const hook = renderHook(() => useReadingLibraryQuery({ snapshot: { items: [], loading: false }, source, section: 'inbox', query: '', tag: null }));
		// Before: the unanswered first page listed an empty inbox and offered to save a first link.
		await act(async () => { await vi.advanceTimersByTimeAsync(100); });
		expect(hook.current).toMatchObject({ count: 0, loading: true });
		// The spinner had not appeared yet, so the answer shows at once.
		await act(async () => { answer(); await vi.advanceTimersByTimeAsync(0); });
		expect(hook.current).toMatchObject({ items: [systems], count: 1, loading: false });
	} finally { vi.useRealTimers(); }
});

it('keeps the previous section listed until another section answers, then shows a loading state only when slow', async () => {
	vi.useFakeTimers();
	try {
		const archived = { ...note('archived', 'Archived essay'), reading_status: 'archived' } as ReadingItem;
		let answer: () => void = () => {};
		const load = vi.fn(async ({ section }: { section: string }) => {
			// Favorites never answers; Archive answers when the test says.
			if (section === 'favorites') await new Promise<never>(() => {});
			if (section === 'archived') await new Promise<void>(resolve => { answer = resolve; });
			return { items: section === 'archived' ? [archived] : [systems, cooking], cursor: null };
		});
		const source: ReadingLibrarySource = { load, loadTags: async () => [], revision: 1, present: items => items };
		let section: 'inbox' | 'archived' | 'favorites' = 'inbox';
		const hook = renderHook(() => useReadingLibraryQuery({ snapshot: { items: [], loading: false }, source, section, query: '', tag: null, holdPrevious: true }));
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		section = 'archived';
		hook.rerender();
		// Before: the new section listed nothing at once, so a quick answer faded out to an empty screen and back in.
		await act(async () => { await vi.advanceTimersByTimeAsync(100); });
		expect(hook.current).toMatchObject({ section: 'inbox', count: 2, loading: false, pending: true });
		await act(async () => { answer(); await vi.advanceTimersByTimeAsync(0); });
		expect(hook.current).toMatchObject({ section: 'archived', items: [archived], count: 1, loading: false, pending: false });
		section = 'favorites';
		hook.rerender();
		await act(async () => { await vi.advanceTimersByTimeAsync(100); });
		expect(hook.current).toMatchObject({ section: 'archived', loading: false });
		// A slow section shows its own loading state rather than the previous list.
		await act(async () => { await vi.advanceTimersByTimeAsync(400); });
		expect(hook.current).toMatchObject({ section: 'favorites', items: [], loading: true });
	} finally { vi.useRealTimers(); }
});
