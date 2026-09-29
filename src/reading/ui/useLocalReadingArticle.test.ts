import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { ReadingLibrary } from '../data/library';
import type { ReadingItem } from '../core/model';
import { useLocalReadingArticle } from './useLocalReadingArticle';

const first: ReadingItem = { crate_reading_version: 1, crate_reading_id: 'first', source_url: 'https://example.com',
  title: 'First', saved_at: '2026-09-29T00:00:00Z', path: 'Reading/first.md', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' };
const second = { ...first, crate_reading_id: 'second', path: 'Reading/second.md' };
type Article = Awaited<ReturnType<ReadingLibrary['read']>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function library() {
  return new ReadingLibrary({ files: () => [], read: async () => '', process: async () => '', create: async () => {} }, 'Reading', new AbortController().signal);
}

it('publishes only the latest open with its matching highlight', async () => {
  const source = library(), a = deferred<Article>(), b = deferred<Article>();
  vi.spyOn(source, 'read').mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const rendered = renderHook(() => useLocalReadingArticle(source, [first, second]));
  let openingA!: Promise<void>, openingB!: Promise<void>;
  const highlight = { start: 0, end: 4, text: 'Body' };
  await act(async () => { openingA = rendered.current.open(first); openingB = rendered.current.open(second, highlight); });
  await act(async () => { b.resolve({ item: second, markdown: 'Body B' }); await openingB; });
  await act(async () => { a.resolve({ item: first, markdown: 'Body A' }); await openingA; });
  expect(rendered.current.article).toEqual({ item: second, markdown: 'Body B' });
  expect(rendered.current.focusHighlight).toBe(highlight);
});

it.each(['close', 'replace', 'unmount'] as const)('invalidates an in-flight open on %s', async change => {
  let source = library();
  const delayed = deferred<Article>();
  vi.spyOn(source, 'read').mockReturnValueOnce(delayed.promise);
  const rendered = renderHook(() => useLocalReadingArticle(source, [first]));
  let opening!: Promise<void>;
  await act(async () => { opening = rendered.current.open(first); });
  if (change === 'close') await act(async () => rendered.current.close());
  if (change === 'replace') { source = library(); rendered.rerender(); }
  if (change === 'unmount') rendered.unmount();
  await act(async () => { delayed.resolve({ item: first, markdown: 'Old library' }); await opening; });
  expect(rendered.current.article).toBeNull();
});

it('hides an already open article when the library is replaced', async () => {
  let source = library();
  vi.spyOn(source, 'read').mockResolvedValue({ item: first, markdown: 'Private old content' });
  const rendered = renderHook(() => useLocalReadingArticle(source, [first]));
  await act(async () => rendered.current.open(first));
  expect(rendered.current.article?.markdown).toBe('Private old content');
  source = library(); rendered.rerender();
  expect(rendered.current.article).toBeNull();
  expect(rendered.current.item).toBeNull();
});

it('does not publish an old update into a reopened article with the same identity', async () => {
  const source = library(), saving = deferred<void>();
  const read = vi.spyOn(source, 'read').mockResolvedValueOnce({ item: first, markdown: 'Before' })
    .mockResolvedValueOnce({ item: first, markdown: 'Reopened' });
  vi.spyOn(source, 'update').mockReturnValue(saving.promise);
  const rendered = renderHook(() => useLocalReadingArticle(source, [first]));
  await act(async () => rendered.current.open(first));
  let update!: Promise<void>;
  await act(async () => { update = rendered.current.update({ favorite: true }); rendered.current.close(); });
  await act(async () => rendered.current.open(first));
  await act(async () => { saving.resolve(); await update; });
  expect(read).toHaveBeenCalledTimes(2);
  expect(rendered.current.article?.markdown).toBe('Reopened');
});

it('refreshes changed article metadata but never reopens a closed reader', async () => {
  const source = library(), refreshed = deferred<Article>();
  vi.spyOn(source, 'read').mockResolvedValueOnce({ item: first, markdown: 'Before' }).mockReturnValueOnce(refreshed.promise);
  let items = [first];
  const rendered = renderHook(() => useLocalReadingArticle(source, items));
  await act(async () => rendered.current.open(first));
  const updated = { ...first, extraction_status: 'pending' as const };
  items = [updated]; rendered.rerender();
  await act(async () => rendered.current.close());
  await act(async () => { refreshed.resolve({ item: updated, markdown: 'Updated body' }); });
  expect(rendered.current.article).toBeNull();
});
