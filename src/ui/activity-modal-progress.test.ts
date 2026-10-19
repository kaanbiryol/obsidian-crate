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
vi.mock('./activity/pending-browser', () => ({
    renderPendingBrowser: (container: FakeElement) => { container.createDiv({ cls: 'crate-pending-browser' }); },
}));

describe('activity modal completion progress', () => {
    it.each(['idle', 'error'] as const)('refreshes saved plugin transfers after the engine becomes %s', async status => {
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
        await Promise.resolve();

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

it('updates progress without copying the pending list or rebuilding the empty conflicts panel', async () => {
    const pending = Array.from({ length: 5000 }, (_, index) => `note-${index}.md`);
    const state = { status: 'syncing', lastSync: null, lastError: null, pendingChanges: pending.length, conflictCount: 0 } as SyncState;
    const getPendingPaths = vi.fn(() => [...pending]);
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, {
        getState: () => state, getActivityProgress: () => null, getPendingPaths, getPendingChangeCount: () => pending.length,
        getActiveConflicts: () => [], sync: vi.fn(), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
    });
    const internal = modal as unknown as {
        pendingPanel: FakeElement; conflictsPanel: FakeElement; syncBtn: FakeElement; syncBtnLabel: FakeElement;
        subtitleEl: FakeElement; subtitleLabelEl: FakeElement; onProgress(): void; renderConflicts(): void;
    };
    internal.pendingPanel = new FakeElement('div');
    internal.pendingPanel.createSpan({ cls: 'crate-activity-loading-label' });
    for (const key of ['conflictsPanel', 'syncBtn', 'syncBtnLabel', 'subtitleEl', 'subtitleLabelEl'] as const) internal[key] = new FakeElement('div');
    const renderConflicts = vi.spyOn(internal, 'renderConflicts');

    for (let tick = 0; tick < 100; tick++) { internal.onProgress(); await Promise.resolve(); }

    // Before: about 4 full copies per tick and a conflicts rebuild on every tick.
    expect(getPendingPaths).not.toHaveBeenCalled();
    expect(renderConflicts).toHaveBeenCalledOnce();
    expect(internal.subtitleLabelEl.textContent).toBe('Syncing…');
});

it('applies a state change and progress tick from the same event once', async () => {
    const state = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 } as SyncState;
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, {
        getState: () => state, getActivityProgress: () => null, getPendingPaths: () => [], getActiveConflicts: () => [],
        sync: vi.fn(), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
    });
    const internal = modal as unknown as { pendingPanel: FakeElement; onProgress(): void; onStateChange(): void; refresh(): void };
    internal.pendingPanel = new FakeElement('div');
    const refresh = vi.spyOn(internal, 'refresh').mockImplementation(() => {});

    for (let event = 0; event < 50; event++) { internal.onStateChange(); internal.onProgress(); }
    expect(refresh).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(refresh).toHaveBeenCalledOnce();
});

it('keeps the pending file browser and its comparisons while the pending set is unchanged', () => {
    let pending = ['a.md', 'b.md'];
    const state = { status: 'idle', lastSync: '2026-01-01T00:00:00.000Z', lastError: null, pendingChanges: 2, conflictCount: 0 } as SyncState;
    const loadPendingDiff = vi.fn(() => new Promise<never>(() => {}));
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, {
        getState: () => state, getActivityProgress: () => null, getPendingPaths: () => [...pending], getActiveConflicts: () => [],
        loadPendingDiff, sync: vi.fn(), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
    });
    const internal = modal as unknown as {
        pendingPanel: FakeElement; syncBtn: FakeElement; syncBtnLabel: FakeElement; renderPending(): void;
        pendingBrowserState: { dispose?: () => void };
    };
    for (const key of ['pendingPanel', 'syncBtn', 'syncBtnLabel'] as const) internal[key] = new FakeElement('div');
    internal.renderPending();
    const browser = internal.pendingPanel.querySelector('.crate-pending-browser');
    expect(browser).toBeTruthy();
    const dispose = vi.fn();
    internal.pendingBrowserState.dispose = dispose;

    internal.renderPending();
    expect(internal.pendingPanel.querySelector('.crate-pending-browser')).toBe(browser);
    expect(dispose).not.toHaveBeenCalled();

    pending = ['a.md'];
    internal.renderPending();
    expect(dispose).toHaveBeenCalledOnce();
    expect(internal.pendingPanel.querySelector('.crate-pending-browser')).not.toBe(browser);
});
