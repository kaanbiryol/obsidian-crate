import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../../test/fakes/obsidian-ui';
import type { SyncState } from '../../sync/types';

vi.mock('obsidian', () => createObsidianUiModule());
vi.mock('../activity-modal', () => ({ ActivityModal: vi.fn() }));
vi.mock('../sync-error-notice', () => ({ showSyncErrorNotice: vi.fn() }));
vi.mock('../../sync/conflict', () => ({ notifyConflicts: vi.fn() }));
import { renderConnectionStatus } from './connection-status';

afterEach(() => { resetObsidianUiMocks(); vi.clearAllMocks(); });

describe('connection status', () => {
	it('can stop an active sync without disconnecting the vault', async () => {
		const stopSync = vi.fn(async () => {});
		const cleanup = renderConnectionStatus(new FakeElement('div') as never, {
			refreshSettingsTab: vi.fn(),
			syncRuntime: {
				getState: () => ({ status: 'syncing', lastSync: null }),
				stopSync, addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(),
			},
		} as never);
		const button = MockSetting.instances[0]!.buttons.find(button => button.buttonEl.textContent === 'Stop sync')!;
		button.click();
		await vi.waitFor(() => expect(stopSync).toHaveBeenCalledOnce());
		cleanup();
	});

	it('shows runtime failures and removes its live listener when settings close', () => {
		let state: SyncState = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };
		const addStateChangeListener = vi.fn();
		const removeStateChangeListener = vi.fn();
		const cleanup = renderConnectionStatus(new FakeElement('div') as never, {
			settings: { workerUrl: 'https://crate.example' },
			syncRuntime: { getState: () => state, addStateChangeListener, removeStateChangeListener },
		} as never);
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
