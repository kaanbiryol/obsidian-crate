import { describe, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement } from '../test/fakes/obsidian-ui';
import { ActivityModal } from './activity-modal';
import { recordSyncHistory } from '../sync/runtime-history';
import { createEmptySyncResult } from '../sync/sync-result';
import { DEFAULT_SETTINGS } from '../plugin/settings-types';
import type { SyncState } from '../sync/types';

vi.mock('obsidian', () => createObsidianUiModule());
vi.mock('./activity/ActivitySheet', () => ({ ActivitySheet: vi.fn() }));
vi.mock('./activity/conflict-review-modal', () => ({ ConflictReviewModal: vi.fn() }));

describe('activity modal completion progress', () => {
    it.each(['idle', 'error'] as const)('refreshes saved plugin transfers after the engine becomes %s', status => {
        const settings = { ...DEFAULT_SETTINGS, syncHistory: [] };
        const deps = {
            getState: () => ({ status } as SyncState),
            getActivityProgress: () => null,
            getPendingPaths: () => [], getActiveConflicts: () => [],
            sync: vi.fn(), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
        };
        const modal = new ActivityModal({} as never, settings, deps);
        const panel = new FakeElement('div');
        const internal = modal as unknown as {
            pendingPanel: HTMLElement; onProgress(): void; refresh(): void;
        };
        internal.pendingPanel = panel as unknown as HTMLElement;
        const refresh = vi.spyOn(internal, 'refresh').mockImplementation(() => {});
        recordSyncHistory(settings, 'sync', createEmptySyncResult());
        internal.refresh(); // Engine's final state arrives before the result is recorded.
        expect(settings.syncHistory[0]).toMatchObject({ uploaded: 0 });
        const uploadedPaths = Array.from({ length: 53 }, (_, index) => `.obsidian/plugins/plugin-${index}/data.json`);
        recordSyncHistory(settings, 'sync', { ...createEmptySyncResult(), uploaded: 53, uploadedPaths });
        refresh.mockClear();

        internal.onProgress(); // Runtime completion event follows history persistence.

        expect(refresh).toHaveBeenCalledOnce();
        expect(settings.syncHistory[0]).toMatchObject({ uploaded: 53, uploadedPaths: uploadedPaths.slice(0, 50) });
    });
});


it('shows the reachability warning without treating it as a failed sync', () => {
    const state: SyncState = {
        status: 'offline', lastSync: null, lastError: 'Cannot reach the temporary tunnel address.',
        pendingChanges: 0, conflictCount: 0,
    };
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, {
        getState: () => state, getPendingPaths: () => [], getActiveConflicts: () => [],
        sync: vi.fn(), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
    });
    const internal = modal as unknown as {
        errorNoticeEl: HTMLElement; errorTitleEl: HTMLElement; errorIssuesEl: HTMLElement;
        updateSyncErrorNotice(): void;
    };
    internal.errorNoticeEl = new FakeElement('div') as unknown as HTMLElement;
    internal.errorTitleEl = new FakeElement('span') as unknown as HTMLElement;
    internal.errorIssuesEl = new FakeElement('span') as unknown as HTMLElement;
    internal.updateSyncErrorNotice();
    expect(internal.errorTitleEl.textContent).toBe('Server unavailable');
    expect((internal.errorIssuesEl as unknown as FakeElement).collectText()).toContain('temporary tunnel address');
});
