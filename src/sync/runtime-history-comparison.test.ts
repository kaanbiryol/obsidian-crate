import { expect, it, vi } from 'vitest';
import { loadRuntimeHistoryComparison } from './runtime-history-workflow';
import type { SyncHistoryEntry } from './types';

const point = (id: string): SyncHistoryEntry => ({ timestamp: '2026-09-20T10:18:42Z', type: 'sync', success: true,
    uploaded: 1, downloaded: 0, merged: 0, deleted: 0, conflictCount: 0, errorCount: 0, sharedCheckpoint: id });
function harness() {
    let connected = true;
    const verify = () => { if (!connected) throw new Error('Sync connection changed. Reopen history.'); };
    const preview = vi.fn(async () => ({ current: 'unsynced local edit', saved: 'selected saved contents' }));
    const engine = { loadHistoryComparison: vi.fn(async (_id: string, _shared: boolean) => ({ compared: true,
        items: [{ path: 'note.md', action: 'modified' as const }], preview })) };
    return { engine, preview, disconnect: () => { connected = false; },
        compare: (entry: SyncHistoryEntry) => loadRuntimeHistoryComparison(engine, verify, entry) };
}
it('compares the selected checkpoint with the current vault without needing a preceding checkpoint', async () => {
    const h = harness();
    const comparison = await h.compare(point('selected'));
    expect(h.engine.loadHistoryComparison.mock.calls).toEqual([['selected', true]]);
    expect(comparison.compared).toBe(true);
    expect(await comparison.preview('note.md')).toEqual({ current: 'unsynced local edit', saved: 'selected saved contents' });
});
it('supports a legacy local checkpoint', async () => {
    const h = harness();
    await h.compare({ ...point('unused'), sharedCheckpoint: undefined, historyCheckpoint: 'local' });
    expect(h.engine.loadHistoryComparison.mock.calls).toEqual([['local', false]]);
});
it('requires a saved state instead of treating the recorded transfer paths as a snapshot', async () => {
    const h = harness();
    await expect(h.compare({ ...point('unused'), sharedCheckpoint: undefined })).rejects.toThrow('no saved state');
    expect(h.engine.loadHistoryComparison).not.toHaveBeenCalled();
});
it.each(['expired checkpoint', 'cannot read current vault'])('surfaces %s without substituting a different comparison', async message => {
    const h = harness();
    h.engine.loadHistoryComparison.mockRejectedValue(new Error(message));
    await expect(h.compare(point('selected'))).rejects.toThrow(message);
    expect(h.preview).not.toHaveBeenCalled();
});
it('rejects preview after the connection changes', async () => {
    const h = harness();
    const comparison = await h.compare(point('selected'));
    h.disconnect();
    await expect(comparison.preview('note.md')).rejects.toThrow('connection changed');
    expect(h.preview).not.toHaveBeenCalled();
});
it('rejects a comparison completed after the connection changes', async () => {
    const h = harness();
    const pending = h.compare(point('selected'));
    h.disconnect();
    await expect(pending).rejects.toThrow('connection changed');
});
it('rejects a preview completed after the connection changes', async () => {
    const h = harness();
    const comparison = await h.compare(point('selected'));
    const pending = comparison.preview('note.md');
    h.disconnect();
    await expect(pending).rejects.toThrow('connection changed');
});
