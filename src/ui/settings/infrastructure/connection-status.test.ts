import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, noticeMessages, resetObsidianUiMocks } from '../../../test/fakes/obsidian-ui';
import type { SyncState } from '../../../sync/types';
import { showSyncErrorNotice } from '../../sync-error-notice';

vi.mock('obsidian', () => createObsidianUiModule());
const openActivity = vi.hoisted(() => vi.fn());
vi.mock('../../activity/activity-modal', () => ({ ActivityModal: vi.fn(function () { return { open: openActivity }; }) }));
vi.mock('../../sync-error-notice', () => ({ showSyncErrorNotice: vi.fn() }));
import { ActivityModal } from '../../activity/activity-modal';
import { renderConnectionStatus } from './connection-status';

afterEach(() => { resetObsidianUiMocks(); vi.clearAllMocks(); });

describe('connection status', () => {
	it('restores the sync button without reporting cancellation as an error', async () => {
		const sync = vi.fn().mockResolvedValue({ outcome: 'cancelled', success: false, errors: [], conflicts: [] });
		const cleanup = renderConnectionStatus({ containerEl: new FakeElement('div') as never, plugin: {
			syncRuntime: {
				getState: () => ({ status: 'idle', lastSync: null }),
				sync, isConfigured: () => true, addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
			},
		} as never });
		const button = MockSetting.instances[0]!.buttons.find(button => button.buttonEl.textContent === 'Sync now')!;
		button.click();
		await vi.waitFor(() => expect(button.buttonEl.classNames.has('is-disabled')).toBe(false));
		expect(sync).toHaveBeenCalledOnce();
		expect(showSyncErrorNotice).not.toHaveBeenCalled();
		expect(noticeMessages).toEqual([]);
		cleanup();
	});

	it('opens sync activity, which owns Stop sync, when Sync now starts a sync', async () => {
		const stopSync = vi.fn(async () => {});
		const sync = vi.fn().mockResolvedValue({ outcome: 'success', success: true, errors: [], conflicts: [] });
		const cleanup = renderConnectionStatus({ containerEl: new FakeElement('div') as never, plugin: {
			settings: {},
			syncRuntime: {
				getState: () => ({ status: 'idle', lastSync: null }),
				sync, stopSync, isConfigured: () => true, addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
			},
		} as never });
		const buttons = MockSetting.instances[0]!.buttons;
		expect(buttons.map(button => button.buttonEl.textContent)).toEqual(['Sync now']);
		buttons[0]!.click();
		await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
		expect(openActivity).toHaveBeenCalledOnce();
		const actions = vi.mocked(ActivityModal).mock.calls[0]![3] as { stop: () => Promise<void> };
		await actions.stop();
		expect(stopSync).toHaveBeenCalledOnce();
		cleanup();
	});

	it('shows runtime failures and removes its live listener when settings close', () => {
		let state: SyncState = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };
		const addStateChangeListener = vi.fn();
		const removeStateChangeListener = vi.fn();
		const cleanup = renderConnectionStatus({ containerEl: new FakeElement('div') as never, plugin: {
			settings: { workerUrl: 'https://crate.example' },
			syncRuntime: { getState: () => state, addStateChangeListener, removeStateChangeListener },
		} as never });
		const setting = MockSetting.instances[0]!;
		expect(setting.descEl.textContent).toContain('Not synced yet');
		expect(setting.descEl.textContent).toContain('Last successful sync: Never');
		state = { ...state, status: 'error', lastError: 'Connection failed' };
		const listener = addStateChangeListener.mock.calls[0]![0] as () => void;
		listener();
		expect(setting.descEl.textContent).toContain('Sync failed');
		expect(setting.descEl.textContent).toContain('Connection failed');
		state = { ...state, status: 'offline', lastError: 'Cannot reach the temporary tunnel address.' };
		listener();
		expect(setting.descEl.textContent).toContain('Server unavailable');
		expect(setting.descEl.textContent).toContain('temporary tunnel address');
		cleanup();
		expect(removeStateChangeListener).toHaveBeenCalledExactlyOnceWith(listener);
	});
});
