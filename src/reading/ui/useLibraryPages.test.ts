import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '../core/model';
import { useLibraryPages, type ReadingLibrarySource } from './useLibraryPages';

const item = { crate_reading_id: 'found', title: 'Found' } as ReadingItem;

it('follows a few empty pages that a bounded highlight scan returns, then waits for Show more', async () => {
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
		// The first request and three follows, so the list shows Show more after four pages.
		expect(load.mock.calls.map(([query]) => query.cursor)).toEqual([null, '1', '2', '3']);
		expect(hook.current).toMatchObject({ items: [], cursor: '4', loading: false });
		await act(async () => { hook.current.loadMore(); await vi.runAllTimersAsync(); });
		expect(hook.current).toMatchObject({ items: [item], cursor: null });
	} finally { vi.useRealTimers(); }
});
