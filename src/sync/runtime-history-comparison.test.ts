import { expect, it, vi } from 'vitest';
import { createRuntimeHarness, setSyncEngine } from './runtime-test-harness';
import type { SyncHistoryEntry } from './types';
import { computeHash } from './hasher';
import { createEmptySyncResult } from './sync-result';
const point = (id: string): SyncHistoryEntry => ({ timestamp: '2026-09-20T10:18:42Z', type: 'sync', success: true,
    uploaded: 1, downloaded: 0, merged: 0, deleted: 0, conflictCount: 0, errorCount: 0, sharedCheckpoint: id });
async function harness() {
    const h = createRuntimeHarness();
    const read = vi.fn(async (_path: string, file: { revision?: string }) => new TextEncoder().encode(file.revision).buffer);
    const loadHistorySnapshot = vi.fn(async (id: string) => ({ files: { 'note.md': {
        hash: await computeHash(new TextEncoder().encode(id).buffer), size: id.length, modified: '2026-09-20', revision: id,
    } }, read }));
    const engine = {
        loadHistorySnapshot,
        sync: vi.fn(async () => createEmptySyncResult()),
        initialSync: vi.fn(async () => createEmptySyncResult()),
        forceFullSync: vi.fn(async () => createEmptySyncResult()),
    };
    setSyncEngine(h.runtime, engine);
    return { ...h, engine, read };
}
it('loads both selected and preceding snapshots and leaves settings untouched', async () => {
    const h = await harness();
    const comparison = await h.runtime.loadHistoryComparison(point('after'), point('before'));
    expect(h.engine.loadHistorySnapshot.mock.calls).toEqual([['after', true], ['before', true]]);
    expect(await comparison.preview('note.md')).toEqual({ current: 'before', saved: 'after' });
    expect(h.persistSettings).not.toHaveBeenCalled();
});
it('falls back to saved contents when the previous snapshot cannot be loaded', async () => {
    const h = await harness();
    const snapshot = await h.engine.loadHistorySnapshot('after');
    h.engine.loadHistorySnapshot.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('expired'));
    const comparison = await h.runtime.loadHistoryComparison(point('after'), point('before'));
    expect(comparison.compared).toBe(false);
    expect(comparison.notice).toContain('earlier saved state could not be loaded');
    expect(await comparison.preview('note.md')).toEqual({ current: '', saved: 'after' });
});
it('does not substitute live contents for an expired selected snapshot', async () => {
    const h = await harness();
    h.engine.loadHistorySnapshot.mockRejectedValue(new Error('expired'));
    await expect(h.runtime.loadHistoryComparison(point('after'))).rejects.toThrow('expired');
    expect(h.read).not.toHaveBeenCalled();
});
it('rejects preview after the connection changes', async () => {
    const h = await harness();
    const comparison = await h.runtime.loadHistoryComparison(point('after'), point('before'));
    setSyncEngine(h.runtime, { ...h.engine });
    await expect(comparison.preview('note.md')).rejects.toThrow('connection changed');
    expect(h.read).not.toHaveBeenCalled();
});
