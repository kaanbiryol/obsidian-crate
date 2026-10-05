import { describe, expect, it, vi } from 'vitest';
import type { SettingsSnapshot } from '../settings-store';
import { pwaSyncState, refreshPwaSync, logoutPwaSync } from './state';

function snapshot(): SettingsSnapshot {
	const feature = { updateReady: true, updateContentReady: true, canApplyUpdate: () => true, ready: true, connected: true, enabled: true, pendingCount: 0, status: { state: 'synced' as const, label: 'All changes synced' }, attention: null, unsynced: false, onRefresh: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) };
	return { open: false, syncRequested: false,
		reading: { ...feature, shortcut: null, issues: null },
		reminders: { ...feature, onRefresh: vi.fn(async () => {}), config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 }, push: { phase: 'unsupported', status: null }, onEnablePush: vi.fn(async () => {}), recovery: null },
	};
}

describe('application sync coordination', () => {
	it.each(['updateReady', 'canApplyUpdate'])('requires explicit %s consent from every hydrated feature', field => {
		const state = snapshot();
		Reflect.deleteProperty(state.reading!, field);
		expect(pwaSyncState(state).canUpdate).toBe(false);
	});
	it('never treats an uninitialized feature as synced or safe to update', () => {
		const state = snapshot(); state.reading = null;
		expect(pwaSyncState(state)).toMatchObject({ ready: false, unsynced: true, canUpdate: false, status: { state: 'syncing' } });
	});
	it('reports Reading errors while Reminders is synced', () => {
		const state = snapshot(); state.reading!.attention = 'Change needs review'; state.reading!.unsynced = true;
		expect(pwaSyncState(state)).toMatchObject({ ready: true, canUpdate: false, status: { state: 'error', label: 'Reading: Change needs review' } });
	});
	it('makes paused features ready while retaining their saved work', () => {
		const state = snapshot(); state.reading!.enabled = false; state.reading!.status = { state: 'cached', label: 'Paused' };
		expect(pwaSyncState(state)).toMatchObject({ ready: true, canUpdate: true, status: { state: 'synced' } });
		state.reading!.pendingCount = 2; state.reading!.unsynced = true; state.reading!.status.label = 'Paused: 2 changes saved on this device';
		expect(pwaSyncState(state)).toMatchObject({ ready: true, unsynced: true, canUpdate: false, pendingCount: 2, status: { state: 'cached', label: 'Reading: Paused: 2 changes saved on this device' } });
	});
	it('includes disconnected recovery and editor activity in update decisions', () => {
		const state = snapshot(); state.reading!.connected = false; state.reading!.unsynced = true;
		expect(pwaSyncState(state).canUpdate).toBe(false);
		state.reading!.unsynced = false; state.reminders!.updateReady = false;
		expect(pwaSyncState(state).canUpdate).toBe(false);
	});
	it('totals pending work without hiding offline or retry deadlines', () => {
		const state = snapshot();
		state.reading!.pendingCount = 1; state.reading!.unsynced = true; state.reading!.retryAt = 100;
		state.reminders!.pendingCount = 2; state.reminders!.unsynced = true; state.reminders!.status.state = 'offline';
		expect(pwaSyncState(state)).toMatchObject({ pendingCount: 3, nextRetryAt: 100, status: { state: 'offline', label: 'Offline: 3 changes waiting to sync' } });
	});
	it('refreshes healthy features even when another fails, and skips paused features', async () => {
		const state = snapshot(); state.reading!.onRefresh = vi.fn(async () => { throw new Error('Reading failed'); });
		await expect(refreshPwaSync(state)).rejects.toThrow('Reading failed');
		expect(state.reminders!.onRefresh).toHaveBeenCalledOnce();
		state.reading!.enabled = false;
		await expect(refreshPwaSync(state)).resolves.toBeUndefined();
		expect(state.reading!.onRefresh).toHaveBeenCalledOnce();
		expect(state.reminders!.onRefresh).toHaveBeenCalledTimes(2);
	});
});

it('clears both private views before asynchronous logout finishes', async () => {
	const state = snapshot(); const order: string[] = [];
	let finish!: () => void;
	state.reminders!.onLogout = () => { order.push('revoke'); return new Promise(resolve => { finish = resolve; }); };
	state.reminders!.clearView = () => order.push('clear reminders');
	state.reading!.clearView = () => order.push('clear reading');
	const pending = logoutPwaSync(state);
	expect(order).toEqual(['revoke', 'clear reminders', 'clear reading']);
	finish(); await pending;
});
