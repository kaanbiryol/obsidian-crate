import { expect, it, vi } from 'vitest';
import { FakeElement } from '../test/fakes/obsidian-ui';
import type { SyncState } from '../sync/types';
import { StatusBarManager } from './status';
import { describeActivityStatus } from './activity/activity-status';
import { registerSyncStatus } from '../plugin/sync-status';

const { render } = vi.hoisted(() => ({ render: vi.fn<(element: { props: { state: SyncState } }) => void>() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render, unmount: vi.fn() }) }));

function enabledStatus(plugin: ReturnType<typeof createPlugin>['plugin'], onClick: () => void) {
	const status = new StatusBarManager(plugin as never, onClick);
	status.setEnabled(true);
	return status;
}

function createPlugin() {
	const items: FakeElement[] = [];
	const removed: Array<ReturnType<typeof vi.fn>> = [];
	const plugin = {
		addStatusBarItem: vi.fn(() => {
			const item = new FakeElement('div');
			const removeEventListener = vi.fn();
			Object.assign(item, { removeEventListener });
			items.push(item);
			removed.push(removeEventListener);
			return item;
		}),
		registerDomEvent: vi.fn(),
	};
	return { plugin, items, removed };
}

const syncing: SyncState = { status: 'syncing', lastSync: '2026-10-01T00:00:00Z', lastError: null, pendingChanges: 4, conflictCount: 0 };

it('renders a progress tick once with the runtime state', () => {
	const { plugin, items } = createPlugin();
	const status = enabledStatus(plugin, vi.fn());
	render.mockClear();

	status.update(syncing, { type: 'sync', current: 2, total: 3 });

	// Before: a placeholder state render, then the real state.
	expect(render).toHaveBeenCalledOnce();
	expect(render.mock.calls[0]![0].props.state).toBe(syncing);
	expect(items[0]!.getAttribute('aria-label')).toContain('2/3');
});

it('does not retain listeners for status bar items it destroyed', () => {
	const { plugin, items, removed } = createPlugin();
	const onClick = vi.fn();
	const status = enabledStatus(plugin, onClick);
	for (let cycle = 0; cycle < 5; cycle++) {
		status.setEnabled(false);
		status.setEnabled(true);
	}

	expect(plugin.registerDomEvent).not.toHaveBeenCalled();
	items.slice(0, -1).forEach((item, index) => {
		expect(item.isConnected).toBe(false);
		expect(removed[index]).toHaveBeenCalledTimes(3);
	});
	items.at(-1)!.dispatchEvent({ type: 'click' } as Event);
	expect(onClick).toHaveBeenCalledOnce();
});

const idle: SyncState = { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 };

it.each<[string, Partial<SyncState>, string]>([
	['errors', { status: 'error' }, 'Last sync had errors'],
	['one pending change', { pendingChanges: 1 }, '1 change pending'],
	['pending changes after a sync', { pendingChanges: 2, lastSync: '2026-10-01T00:00:00Z' }, '2 changes pending'],
	['a recent sync', { lastSync: new Date().toISOString() }, 'Synced just now'],
	['no completed sync', {}, 'Not synced yet'],
])('labels %s with the Sync activity phrase', (_, patch, text) => {
	const { plugin, items } = createPlugin();
	const state = { ...idle, ...patch };
	enabledStatus(plugin, vi.fn()).update(state);
	expect(describeActivityStatus(state, null, state.pendingChanges, true, false).text).toBe(text);
	expect(items[0]!.getAttribute('aria-label')).toContain(`Open sync activity. ${text}.`);
});

it('ages the last-sync label without runtime events', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', globalThis);
	try {
		const { plugin, items } = createPlugin();
		const state: SyncState = { ...idle, lastSync: new Date().toISOString() };
		registerSyncStatus({ ...plugin, register: vi.fn(), registerInterval: vi.fn() } as never, {
			isInitialized: () => true, getState: () => state, getActivityProgress: () => null,
			addStateChangeListener: vi.fn(), removeStateChangeListener: vi.fn(), addProgressListener: vi.fn(), removeProgressListener: vi.fn(),
		}, vi.fn());
		expect(items[0]!.getAttribute('aria-label')).toContain('Synced just now');
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(items[0]!.getAttribute('aria-label')).toContain('Synced 5m ago');
	} finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
