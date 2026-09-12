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
	it('shows runtime failures and removes its live listener when settings close', () => {
		let state: SyncState = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };
		const addStateChangeListener = vi.fn();
		const removeStateChangeListener = vi.fn();
		const cleanup = renderConnectionStatus(new FakeElement('div') as never, {
			settings: { workerUrl: 'https://crate.example' },
			syncRuntime: { getState: () => state, addStateChangeListener, removeStateChangeListener },
		} as never);
		const setting = MockSetting.instances[0]!;
		expect(setting.descEl.textContent).toContain('https://crate.example');
		expect(setting.descEl.textContent).toContain('Last successful sync: Never');
		state = { ...state, status: 'error', lastError: 'Connection failed' };
		const listener = addStateChangeListener.mock.calls[0]![0] as () => void;
		listener();
		expect(setting.descEl.textContent).toContain('Sync failed');
		expect(setting.descEl.textContent).toContain('Connection failed');
		cleanup();
		expect(removeStateChangeListener).toHaveBeenCalledExactlyOnceWith(listener);
	});
});
