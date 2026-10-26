import { describe, expect, it, vi } from 'vitest';
import { createObsidianUiModule, FakeElement } from '../../test/fakes/obsidian-ui';
import { ActivityModal, type ActivityModalDeps } from './activity-modal';
import type { ActivityHeader } from './activity-header';
import { recordSyncHistory } from '../../sync/runtime/sync-activity';
import { createEmptySyncResult } from '../../sync/sync-result';
import { DEFAULT_SETTINGS } from '../../plugin/settings-types';
import type { SyncState } from '../../sync/types';

vi.mock('obsidian', () => createObsidianUiModule());
vi.mock('./ActivitySheet', () => ({ ActivitySheet: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));
vi.mock('./conflict-review-modal', () => ({ ConflictReviewModal: vi.fn() }));
vi.mock('./pending-browser', () => ({
	renderPendingBrowser: (container: FakeElement) => { container.createDiv({ cls: 'crate-pending-browser' }); },
}));

/** A sync runtime with nothing pending; tests override what they exercise. */
function runtime(overrides: Partial<ActivityModalDeps>): ActivityModalDeps {
	const unused = () => Promise.reject(new Error('Not used in this test'));
	return {
		loadHistoryComparison: unused, listSharedCheckpoints: async () => [], createHistoryRestore: unused,
		loadPendingDiff: unused, syncSelected: unused, createPendingDiscard: unused, createConflictReview: unused,
		listRecentFileVersions: unused, getPendingRestores: () => [], loadFileHistoryPreview: unused,
		restoreRecentFileVersion: unused, loadCurrentSyncedPreview: unused,
		getPendingKeys: () => [], getPendingChangeCount: () => 0, hasPendingKey: () => false, getActiveConflicts: () => [],
		getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
		getActivityProgress: () => null, addProgressListener: vi.fn(), removeProgressListener: vi.fn(),
		sync: vi.fn(), stopSync: vi.fn(async () => {}), addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
		...overrides,
	};
}

describe('activity modal completion progress', () => {
	it.each(['idle', 'error'] as const)('refreshes saved plugin transfers after the engine becomes %s', async status => {
		const settings = { ...DEFAULT_SETTINGS, syncHistory: [] };
		const modal = new ActivityModal({} as never, settings, runtime({ getState: () => ({ status } as SyncState) }));
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
	const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, runtime({ getState: () => state }));
	const internal = modal as unknown as { createHeader(header: FakeElement, contentEl: FakeElement): ActivityHeader };
	const content = new FakeElement('div');
	internal.createHeader(new FakeElement('div'), content).updateSyncErrorNotice();
	expect(content.querySelector('.crate-sync-error-title')?.textContent).toBe('Server unavailable');
	expect(content.querySelector('.crate-sync-error-message')?.collectText()).toContain('temporary tunnel address');
});

it('updates progress without copying the pending list or rebuilding the empty conflicts panel', async () => {
	const pending = Array.from({ length: 5000 }, (_, index) => `note-${index}.md`);
	const state = { status: 'syncing', lastSync: null, lastError: null, pendingChanges: pending.length, conflictCount: 0 } as SyncState;
	const getPendingKeys = vi.fn(() => [...pending]);
	const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, runtime({
		getState: () => state, getPendingKeys, getPendingChangeCount: () => pending.length,
	}));
	const internal = modal as unknown as {
		pendingPanel: FakeElement; conflictsPanel: FakeElement; header: ActivityHeader; onProgress(): void; renderConflicts(): void;
		createHeader(header: FakeElement, contentEl: FakeElement): ActivityHeader;
	};
	internal.pendingPanel = new FakeElement('div');
	internal.pendingPanel.createSpan({ cls: 'crate-activity-loading-label' });
	internal.conflictsPanel = new FakeElement('div');
	const header = new FakeElement('div');
	internal.header = internal.createHeader(header, new FakeElement('div'));
	const renderConflicts = vi.spyOn(internal, 'renderConflicts');

	for (let tick = 0; tick < 100; tick++) { internal.onProgress(); await Promise.resolve(); }

	// Before: about 4 full copies per tick and a conflicts rebuild on every tick.
	expect(getPendingKeys).not.toHaveBeenCalled();
	expect(renderConflicts).toHaveBeenCalledOnce();
	expect(header.querySelector('.crate-activity-subtitle-label')?.textContent).toBe('Syncing…');
});

it('applies a state change and progress tick from the same event once', async () => {
	const state = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 } as SyncState;
	const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, runtime({ getState: () => state }));
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
	const modal = new ActivityModal({} as never, DEFAULT_SETTINGS, runtime({
		getState: () => state, getPendingKeys: () => [...pending], loadPendingDiff,
	}));
	const internal = modal as unknown as {
		pendingPanel: FakeElement; header: ActivityHeader; renderPending(): void;
		pendingBrowserState: { dispose?: () => void };
		createHeader(header: FakeElement, contentEl: FakeElement): ActivityHeader;
	};
	internal.pendingPanel = new FakeElement('div');
	internal.header = internal.createHeader(new FakeElement('div'), new FakeElement('div'));
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
