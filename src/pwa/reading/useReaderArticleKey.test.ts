import { expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { ReadingItem } from '@/reading/core/model';
import { useReaderArticleKey } from './useReaderArticleKey';

const item = (id: string, path: string, url = 'https://example.com/article') =>
	({ crate_reading_id: id, path, source_url: url, title: 'Article', saved_at: '2026-01-01T00:00:00.000Z', reading_status: 'inbox', favorite: false, tags: [] }) as unknown as ReadingItem;

it('keeps a pending link\'s identity when its note is saved, and changes it for another article', () => {
	let open: ReadingItem | undefined = item('queued-op', '');
	const hook = renderHook(() => useReaderArticleKey(open));
	expect(hook.current).toBe('queued-op');
	// Before: the new ID reset the reader to the top and closed its open sheet.
	open = item('saved-note', 'Reading/article.md');
	hook.rerender();
	expect(hook.current).toBe('queued-op');
	open = item('other', 'Reading/other.md', 'https://example.com/other');
	hook.rerender();
	expect(hook.current).toBe('other');
	open = undefined;
	hook.rerender();
	expect(hook.current).toBeUndefined();
});

it('treats a saved article with a new ID as another article', () => {
	let open = item('first', 'Reading/a.md');
	const hook = renderHook(() => useReaderArticleKey(open));
	open = item('second', 'Reading/b.md');
	hook.rerender();
	expect(hook.current).toBe('second');
});
