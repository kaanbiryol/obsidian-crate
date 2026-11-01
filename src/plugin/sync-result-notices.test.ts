import { beforeEach, expect, it, vi } from 'vitest';
import type { SyncResult, SyncState } from '../sync/types';
import { createEmptySyncResult } from '../sync/sync-result';
import { AUTH_ERROR_MESSAGE } from '../sync/sync-outcome';
import { RESTART_NOTICE, registerSyncResultNotices } from './sync-result-notices';

const { notices } = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock('obsidian', () => ({ Notice: class { constructor(message: string) { notices.push(message); } } }));
beforeEach(() => { notices.length = 0; });

function setup(isMobile = true) {
	let listener!: (result: SyncResult) => void;
	let state: SyncState = { status: 'error', lastSync: null, lastError: 'Upload failed', pendingChanges: 0, conflictCount: 0 };
	const cleanups: Array<() => void> = [];
	const showSyncError = vi.fn();
	const runtime = {
		getState: () => state,
		addSyncResultListener: vi.fn((added: typeof listener) => { listener = added; }),
		removeSyncResultListener: vi.fn(),
	};
	registerSyncResultNotices({ configDir: '.obsidian', isMobile, register: cleanup => cleanups.push(cleanup), showSyncError }, runtime);
	return {
		runtime, showSyncError,
		emit: (result: Partial<SyncResult>) => listener({ ...createEmptySyncResult(), ...result }),
		setState: (next: Partial<SyncState>) => { state = { ...state, ...next }; },
		unload: () => cleanups.forEach(cleanup => cleanup()),
	};
}

const failed = { success: false, outcome: 'failed' as const, errors: ['Upload failed'] };

it('reports a failed sync on mobile once until a sync succeeds again', () => {
	const { emit, showSyncError, runtime, unload } = setup();
	emit(failed);
	emit(failed);
	expect(showSyncError).toHaveBeenCalledOnce();
	emit({ success: true });
	emit(failed);
	expect(showSyncError).toHaveBeenCalledTimes(2);
	unload();
	expect(runtime.removeSyncResultListener).toHaveBeenCalledOnce();
});

it('leaves desktop failures to the status bar and offline or revoked access to their own notices', () => {
	const desktop = setup(false);
	desktop.emit(failed);
	expect(desktop.showSyncError).not.toHaveBeenCalled();
	const offline = setup();
	offline.setState({ status: 'offline' });
	offline.emit(failed);
	const revoked = setup();
	revoked.setState({ lastError: AUTH_ERROR_MESSAGE });
	revoked.emit(failed);
	expect(offline.showSyncError).not.toHaveBeenCalled();
	expect(revoked.showSyncError).not.toHaveBeenCalled();
});

it('asks for one restart when a sync rewrites Obsidian settings, not for notes or uploads', () => {
	const { emit } = setup();
	emit({ success: true, downloadedPaths: ['Notes/a.md'], uploadedPaths: ['.obsidian/app.json'] });
	expect(notices).toEqual([]);
	emit({ success: true, mergedPaths: ['.obsidian/appearance.json'] });
	emit({ success: true, downloadedPaths: ['.obsidian/themes/Minimal/theme.css'] });
	expect(notices).toEqual([RESTART_NOTICE]);
});
