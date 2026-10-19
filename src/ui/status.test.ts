import { expect, it, vi } from 'vitest';
import { FakeElement } from '../test/fakes/obsidian-ui';
import type { SyncState } from '../sync/types';
import { StatusBarManager } from './status';

const { render } = vi.hoisted(() => ({ render: vi.fn<(element: { props: { state: SyncState } }) => void>() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render, unmount: vi.fn() }) }));

function createPlugin() {
	const items: FakeElement[] = [];
	const plugin = {
		addStatusBarItem: vi.fn(() => {
			const item = new FakeElement('div');
			Object.assign(item, { removeEventListener: vi.fn() });
			items.push(item);
			return item;
		}),
		registerDomEvent: vi.fn(),
	};
	return { plugin, items };
}

const syncing: SyncState = { status: 'syncing', lastSync: '2026-10-01T00:00:00Z', lastError: null, pendingChanges: 4, conflictCount: 0 };

it('renders a progress tick once with the runtime state', () => {
	const { plugin, items } = createPlugin();
	const status = new StatusBarManager(plugin as never, true, vi.fn());
	render.mockClear();

	status.setSyncProgress(2, 3);
	status.update(syncing);

	// Before: a placeholder state render, then the real state.
	expect(render).toHaveBeenCalledOnce();
	expect(render.mock.calls[0]![0].props.state).toBe(syncing);
	expect(items[0]!.getAttribute('aria-label')).toContain('2/3');
});
