import { expect, it, vi } from 'vitest';
import type { ChangelogEntry } from '../protocol/sync-types';
import { readIncrementalChangelog } from './incremental-changelog';

function entry(seq: number, path = 'note.md'): ChangelogEntry {
  return { seq, path, action: 'put', hash: `hash-${seq}`, size: 1, created_at: '2026-10-05T12:00:00Z' };
}

it('deduplicates across pages while following the last entry rather than the server watermark', async () => {
  const getChanges = vi.fn<Parameters<typeof readIncrementalChangelog>[0]['getChanges']>()
    .mockResolvedValueOnce({ changes: [entry(2), entry(3, 'other.md')], lastSeq: 9, hasMore: true })
    .mockResolvedValueOnce({ changes: [entry(5)], lastSeq: 9, hasMore: false });
  const result = await readIncrementalChangelog({ getChanges }, 1);
  expect(getChanges.mock.calls).toEqual([[1], [3]]);
  expect(result).toEqual({ changesByPath: new Map([['note.md', entry(5)], ['other.md', entry(3, 'other.md')]]), changeCount: 3, latestSeq: 9 });
});

it('discards partial inventory if a later page has expired', async () => {
  const getChanges = vi.fn<Parameters<typeof readIncrementalChangelog>[0]['getChanges']>()
    .mockResolvedValueOnce({ changes: [entry(2)], lastSeq: 9, hasMore: true })
    .mockResolvedValueOnce({ changes: [], lastSeq: 9, hasMore: false, cursorExpired: true });
  expect(await readIncrementalChangelog({ getChanges }, 1)).toBeNull();
});

it('rejects a repeated cursor instead of looping indefinitely', async () => {
  const getChanges = vi.fn(async () => ({ changes: [entry(2)], lastSeq: 9, hasMore: true }));
  await expect(readIncrementalChangelog({ getChanges }, 1)).rejects.toThrow('Changelog cursor did not advance');
  expect(getChanges).toHaveBeenCalledTimes(2);
});

it('does not fetch another page after cancellation', async () => {
  const lifetime = new AbortController();
  const getChanges = vi.fn(async () => {
    lifetime.abort();
    return { changes: [entry(2)], lastSeq: 9, hasMore: true };
  });
  await expect(readIncrementalChangelog({ getChanges }, 1, () => lifetime.signal.throwIfAborted())).rejects.toMatchObject({ name: 'AbortError' });
  expect(getChanges).toHaveBeenCalledOnce();
});
