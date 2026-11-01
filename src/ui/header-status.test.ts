import { expect, it, vi } from 'vitest';
import { FakeElement } from '../test/fakes/obsidian-ui';
import type { SyncState } from '../sync/types';
import { HeaderSyncIndicator } from './header-status';

const { render, unmount } = vi.hoisted(() => ({ render: vi.fn<(element: { props: { state: SyncState } }) => void>(), unmount: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render, unmount }) }));

function createWorkspace() {
	const views: Array<{ addAction: ReturnType<typeof vi.fn>; actions: FakeElement[] } | object> = [];
	let layoutChange: () => void = () => {};
	const addView = (withActions = true) => {
		const actions: FakeElement[] = [];
		const view = withActions ? {
			actions,
			addAction: vi.fn((_icon: string, _title: string, callback: () => void) => {
				const el = new FakeElement('div');
				Object.assign(el, { click: callback });
				actions.push(el);
				return el;
			}),
		} : {};
		views.push(view);
		return { view, actions };
	};
	const plugin = {
		registerEvent: vi.fn(),
		app: { workspace: {
			on: vi.fn((_name: string, callback: () => void) => { layoutChange = callback; return {}; }),
			iterateRootLeaves: (callback: (leaf: { view: object }) => void) => views.forEach(view => callback({ view })),
		} },
	};
	return { plugin, addView, layoutChange: () => layoutChange() };
}

const synced: SyncState = { status: 'idle', lastSync: '2026-10-01T00:00:00Z', lastError: null, pendingChanges: 0, conflictCount: 0 };

it('adds one indicator per main-area view, including views opened later, and opens activity', () => {
	const { plugin, addView, layoutChange } = createWorkspace();
	const first = addView();
	addView(false);
	const onClick = vi.fn();
	const indicator = new HeaderSyncIndicator(plugin as never, onClick);
	indicator.update({ ...synced, pendingChanges: 2 });
	indicator.setEnabled(true);
	expect(first.actions).toHaveLength(1);
	expect(first.actions[0]!.getAttribute('aria-label')).toBe('Crate sync: 2 changes pending. Open sync activity.');
	expect(render.mock.lastCall?.[0].props.state).toMatchObject({ pendingChanges: 2 });

	const later = addView();
	layoutChange();
	layoutChange();
	expect((first.view as { addAction: ReturnType<typeof vi.fn> }).addAction).toHaveBeenCalledOnce();
	expect(later.actions).toHaveLength(1);

	indicator.update({ ...synced, conflictCount: 1 });
	expect(later.actions[0]!.getAttribute('aria-label')).toBe('Crate sync: 1 conflict. Open sync activity.');
	(later.actions[0] as unknown as { click(): void }).click();
	expect(onClick).toHaveBeenCalledOnce();
});

it('removes its header actions when disabled and replaces actions a view dropped', () => {
	const { plugin, addView, layoutChange } = createWorkspace();
	const { actions } = addView();
	const indicator = new HeaderSyncIndicator(plugin as never, vi.fn());
	indicator.update(synced);
	indicator.setEnabled(true);
	actions[0]!.isConnected = false;
	layoutChange();
	expect(actions).toHaveLength(2);
	expect(unmount).toHaveBeenCalledOnce();

	indicator.setEnabled(false);
	expect(actions[1]!.isConnected).toBe(false);
	layoutChange();
	expect(actions).toHaveLength(2);
});
