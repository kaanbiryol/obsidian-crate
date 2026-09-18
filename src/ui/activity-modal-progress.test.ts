import { describe, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement } from '../test/fakes/obsidian-ui';
import { ActivityModal } from './activity-modal';
import { renderHistoryPanel } from './activity/history';
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
        const refresh = vi.spyOn(internal, 'refresh').mockImplementation(() => {
            panel.empty();
            renderHistoryPanel(panel as unknown as HTMLElement, settings.syncHistory);
        });
        recordSyncHistory(settings, 'sync', createEmptySyncResult());
        internal.refresh(); // Engine's final state arrives before the result is recorded.
        expect(panel.collectText()).toContain('No changes');
        const uploadedPaths = Array.from({ length: 53 }, (_, index) => `.obsidian/plugins/plugin-${index}/data.json`);
        recordSyncHistory(settings, 'sync', { ...createEmptySyncResult(), uploaded: 53, uploadedPaths });
        refresh.mockClear();

        internal.onProgress(); // Runtime completion event follows history persistence.

        expect(refresh).toHaveBeenCalledOnce();
        expect(panel.collectText()).toContain('53 uploaded');
        expect(panel.collectText()).toContain('data.json .obsidian/plugins/plugin-49');
        expect(panel.collectText()).toContain('Showing 50 of 53 uploaded files.');
    });
});


it('keeps Stop sync visible and enabled while pending files are transferring', () => {
    let syncing = true;
    const deps = {
        getState: () => ({ status: syncing ? 'syncing' : 'idle' } as SyncState),
        getPendingPaths: () => ['note.md'], getActiveConflicts: () => [],
        sync: vi.fn(), stopSync: vi.fn(), syncSelected: vi.fn(), createPendingDiscard: vi.fn(), loadPendingDiff: vi.fn(),
        addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
    };
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, deps);
    const button = new FakeElement('button');
    const label = new FakeElement('span');
    const internal = modal as unknown as {
        syncBtn: HTMLElement; syncBtnLabel: HTMLElement; stoppingSync: boolean; updateSyncBtn(): void;
    };
    internal.syncBtn = button as unknown as HTMLElement;
    internal.syncBtnLabel = label as unknown as HTMLElement;
    internal.updateSyncBtn();
    expect((button as unknown as HTMLButtonElement).hidden).toBe(false);
    expect((button as unknown as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Stop sync');
    expect(label.collectText()).toBe('Stop sync');
    internal.stoppingSync = true;
    internal.updateSyncBtn();
    expect(label.collectText()).toBe('Stopping…');
    expect((button as unknown as HTMLButtonElement).disabled).toBe(true);
    internal.stoppingSync = false;
    syncing = false;
    internal.updateSyncBtn();
    expect(button.getAttribute('aria-label')).toBe('Sync now');
    expect(label.collectText()).toBe('Sync now');
    expect((button as unknown as HTMLButtonElement).hidden).toBe(true);
});
