import { expect, it, vi } from 'vitest';
import { ActivityModal } from '../activity-modal';
import { FakeElement } from '../../test/fakes/obsidian-ui';
import { DEFAULT_SETTINGS } from '../../plugin/settings-types';
import type { SharedCheckpoint } from '../../protocol/history-checkpoints';
vi.mock('obsidian', async () => (await import('../../test/fakes/obsidian-ui')).createObsidianUiModule());
vi.mock('./ActivitySheet', () => ({ ActivitySheet: vi.fn() }));

function harness(list: () => Promise<SharedCheckpoint[]>) {
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, { listSharedCheckpoints: list } as never);
    const internal = modal as unknown as { historyActive: boolean; historyPanel: HTMLElement;
        sharedCheckpoints?: SharedCheckpoint[]; loadSharedHistory(): Promise<void>; refresh(): void };
    internal.historyActive = true; internal.historyPanel = new FakeElement('div') as never;
    vi.spyOn(internal, 'refresh').mockImplementation(() => {});
    return internal;
}
it('loads checkpoints even with no local sync history', async () => {
    const list = vi.fn(async () => [] as SharedCheckpoint[]);
    const modal = harness(list);
    await modal.loadSharedHistory();
    expect(list).toHaveBeenCalledOnce();
    expect(modal.sharedCheckpoints).toEqual([]);
});
it('rechecks when sync completes during an older history request', async () => {
    let resolve!: (value: SharedCheckpoint[]) => void;
    const latest: SharedCheckpoint[] = [{ id: 'new', timestamp: '', expiresAt: 1, fileCount: 1, sequence: 1 }];
    const list = vi.fn<() => Promise<SharedCheckpoint[]>>().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(latest);
    const modal = harness(list);
    const first = modal.loadSharedHistory();
    await modal.loadSharedHistory();
    resolve([]); await first;
    await vi.waitFor(() => expect(modal.sharedCheckpoints).toEqual(latest));
    expect(list).toHaveBeenCalledTimes(2);
});
it('preserves history on server errors and does not apply results after the dialog closes', async () => {
    const modal = harness(async () => { throw new Error('Update the Crate server'); });
    modal.sharedCheckpoints = [];
    await modal.loadSharedHistory();
    expect(modal.sharedCheckpoints).toEqual([]);
    let resolve!: (value: SharedCheckpoint[]) => void;
    const closed = harness(() => new Promise(done => { resolve = done; }));
    const pending = closed.loadSharedHistory(); closed.historyActive = false; resolve([]); await pending;
    expect(closed.sharedCheckpoints).toBeUndefined();
});
