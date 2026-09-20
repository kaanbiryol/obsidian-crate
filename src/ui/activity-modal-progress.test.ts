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
    expect(button.getAttribute('aria-label')).toBe('Sync vault');
    expect(label.collectText()).toBe('Sync vault');
    expect((button as unknown as HTMLButtonElement).hidden).toBe(false);
});

it.each([
    ['idle', 1, '1 change pending', 'pending'],
    ['idle', 2, '2 changes pending', 'pending'],
    ['idle', 0, 'Synced just now', 'synced'],
    ['error', 1, 'Last sync had errors', 'attention'],
    ['offline', 1, 'Offline', 'attention'],
] as const)('describes %s with %i pending files in the header', (status, count, text, indicator) => {
    const deps = {
        getState: () => ({ status, lastSync: new Date().toISOString() } as SyncState),
        getPendingPaths: () => Array.from({ length: count }, (_, i) => `${i}.md`),
        getActiveConflicts: () => [],
        sync: vi.fn(), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
    };
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, deps);
    const subtitle = new FakeElement('span');
    const internal = modal as unknown as {
        subtitleEl: HTMLElement; subtitleLabelEl: HTMLElement; conflictsPanel: HTMLElement; updateSyncStatusText(): void;
    };
    internal.subtitleEl = subtitle as unknown as HTMLElement;
    internal.subtitleLabelEl = subtitle.createSpan({ cls: 'crate-activity-subtitle-label' }) as unknown as HTMLElement;
    internal.conflictsPanel = new FakeElement('div') as unknown as HTMLElement;
    internal.updateSyncStatusText();
    expect(subtitle.collectText()).toBe(text);
    expect(subtitle.getAttribute('data-state')).toBe(indicator);
});

it('keeps the header stable while detailed sync phases change', () => {
    const state = { status: 'syncing', work: { phase: 'scanning' } } as SyncState;
    const deps = {
        getState: () => state,
        getPendingPaths: () => ['note.md'], getActiveConflicts: () => [],
        sync: vi.fn(), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
    };
    const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, deps);
    const subtitle = new FakeElement('span');
    const internal = modal as unknown as {
        subtitleEl: HTMLElement; subtitleLabelEl: HTMLElement; conflictsPanel: HTMLElement; updateSyncStatusText(): void;
    };
    internal.subtitleEl = subtitle as unknown as HTMLElement;
    internal.subtitleLabelEl = subtitle.createSpan({ cls: 'crate-activity-subtitle-label' }) as unknown as HTMLElement;
    internal.conflictsPanel = new FakeElement('div') as unknown as HTMLElement;
    for (const phase of ['server', 'scanning', 'preparing', 'uploading', 'downloading', 'applying', 'saving', 'reminders'] as const) {
        state.work = { phase };
        internal.updateSyncStatusText();
        expect(subtitle.collectText()).toBe('Syncing…');
        expect(subtitle.getAttribute('title')).toBe('Syncing…');
        expect(subtitle.getAttribute('data-state')).toBe('syncing');
    }
});
