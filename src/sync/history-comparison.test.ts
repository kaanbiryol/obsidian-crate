import { expect, it, vi } from 'vitest';
import { compareHistorySnapshots, type HistorySnapshot } from './history-comparison';
import { computeHash } from './hasher';
import type { FileEntry } from '../protocol/sync-types';
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
async function snapshot(values: Record<string, string>) {
    const read = vi.fn(async (path: string) => bytes(values[path]!));
    const files: Record<string, FileEntry> = Object.fromEntries(await Promise.all(Object.entries(values).map(async ([path, text]) => [path, {
        hash: await computeHash(bytes(text)), size: bytes(text).byteLength, modified: '2026-09-20', revision: text,
    }] as const)));
    return { files, read } satisfies HistorySnapshot;
}
it('compares complete saved inventories, including additions, deletions and unchanged files', async () => {
    const before = await snapshot({ 'edit.md': 'before', 'deleted.md': 'removed', 'same.md': 'same' });
    const after = await snapshot({ 'edit.md': 'after', 'added.md': 'created', 'same.md': 'same' });
    const comparison = compareHistorySnapshots(after, before);
    expect(comparison.items).toEqual([
        { path: 'added.md', action: 'added' }, { path: 'deleted.md', action: 'deleted' }, { path: 'edit.md', action: 'modified' },
    ]);
    expect(before.read).not.toHaveBeenCalled(); expect(after.read).not.toHaveBeenCalled();
    expect(await comparison.preview('edit.md')).toEqual({ current: 'before', saved: 'after' });
    expect(await comparison.preview('added.md')).toEqual({ current: '', saved: 'created' });
    expect(await comparison.preview('deleted.md')).toEqual({ current: 'removed', saved: '' });
    await expect(comparison.preview('../outside.md')).rejects.toThrow('not in');
});
it('does not invent additions when the preceding state is unknown', async () => {
    const comparison = compareHistorySnapshots(await snapshot({ 'note.md': 'saved' }));
    expect(comparison.compared).toBe(false);
    expect(comparison.items).toEqual([{ path: 'note.md', action: 'saved' }]);
    expect(await comparison.preview('note.md')).toEqual({ current: '', saved: 'saved' });
});
it('does not read contents when both states match or files are too large or binary', async () => {
    const before = await snapshot({ 'same.md': 'same' });
    const after = await snapshot({ 'same.md': 'same', 'big.md': 'a'.repeat(256_001), 'image.png': 'bytes' });
    const comparison = compareHistorySnapshots(after, before);
    expect(await comparison.preview('big.md')).toHaveProperty('unavailable');
    expect(await comparison.preview('image.png')).toHaveProperty('unavailable');
    expect(after.read).not.toHaveBeenCalled();
});
it('rejects wrong historical bytes', async () => {
    const before = await snapshot({ 'note.md': 'before' });
    const after = await snapshot({ 'note.md': 'after' });
    before.read.mockResolvedValue(bytes('current local contents are not the baseline'));
    await expect(compareHistorySnapshots(after, before).preview('note.md')).rejects.toThrow('changed');
});
it('treats prototype-like paths as ordinary historical files', async () => {
    const before = await snapshot(JSON.parse('{"__proto__":"old","constructor":"gone"}') as Record<string, string>);
    const after = await snapshot(JSON.parse('{"__proto__":"new"}') as Record<string, string>);
    const comparison = compareHistorySnapshots(after, before);
    expect(comparison.items).toEqual([{ path: '__proto__', action: 'modified' }, { path: 'constructor', action: 'deleted' }]);
    expect(await comparison.preview('constructor')).toEqual({ current: 'gone', saved: '' });
});
