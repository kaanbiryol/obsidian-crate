import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { createSettingsStore, shallowEqual, type SettingsSnapshot } from './settings-store';
import { SettingsContext, useFeatureSettings, useSettingsSelector } from './settings-context';

type ReadingModel = NonNullable<SettingsSnapshot['reading']>;
function reading(overrides: Partial<ReadingModel> = {}): ReadingModel {
	return { ready: true, connected: true, updateReady: true, updateContentReady: true, attention: null, unsynced: false,
		status: { state: 'synced', label: 'All changes synced' }, canApplyUpdate: () => true,
		onRefresh: async () => {}, onLogout: async () => {}, shortcut: null, issues: null, ...overrides };
}

describe('settings store publication', () => {
	it('skips a feature model whose fields, status and lists are unchanged', () => {
		const store = createSettingsStore();
		const listener = vi.fn();
		store.subscribe(listener);
		const model = reading();
		store.setFeature('reading', model);
		expect(listener).toHaveBeenCalledTimes(1);
		// A runtime rebuilds its status object and lists on every render.
		store.setFeature('reading', { ...model, status: { ...model.status }, encryption: undefined });
		expect(listener).toHaveBeenCalledTimes(2);
		const published = store.getSnapshot();
		store.setFeature('reading', { ...model, status: { ...model.status }, encryption: undefined });
		expect(listener).toHaveBeenCalledTimes(2);
		expect(store.getSnapshot()).toBe(published);
		store.setFeature('reading', { ...model, encryption: undefined, status: { state: 'syncing', label: 'Refreshing Reading' } });
		expect(listener).toHaveBeenCalledTimes(3);
		store.setFeature('reading', null);
		store.setFeature('reading', null);
		expect(listener).toHaveBeenCalledTimes(4);
	});

	it('compares nested lists by their items and elements by identity', () => {
		const store = createSettingsStore();
		const listener = vi.fn();
		store.subscribe(listener);
		const base = reading();
		const { shortcut: _shortcut, issues: _issues, ...feature } = base;
		const reminders = (recoveryChanges: never[]) => ({ ...feature, recoveryChanges, quarantinedChanges: [], onRemoveQuarantined: async () => true,
			config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 }, push: { phase: 'unsupported' as const, status: null }, onEnablePush: async () => {} });
		const first = reminders([]);
		store.setFeature('reminders', first);
		// Empty lists and the config object are rebuilt, with the same callbacks.
		store.setFeature('reminders', { ...reminders([]), onRemoveQuarantined: first.onRemoveQuarantined, onEnablePush: first.onEnablePush });
		expect(listener).toHaveBeenCalledTimes(1);
		const issues = createElement('p');
		store.setFeature('reading', { ...base, issues });
		store.setFeature('reading', { ...base, issues });
		expect(listener).toHaveBeenCalledTimes(2);
		store.setFeature('reading', { ...base, issues: createElement('p') });
		expect(listener).toHaveBeenCalledTimes(3);
		expect(shallowEqual([1, 2], [1, 2])).toBe(true);
		expect(shallowEqual([1, 2], [1])).toBe(false);
		expect(shallowEqual<object>({ a: 1 }, { b: 1 })).toBe(false);
	});
});

describe('feature settings hooks', () => {
	function mount() {
		const store = createSettingsStore();
		const listener = vi.fn();
		store.subscribe(listener);
		let props = { pendingCount: 0, label: 'All changes synced' };
		const refreshes: string[] = [];
		const selections: unknown[] = [];
		const hook = renderHook(() => {
			const { pendingCount, label } = props;
			// Inline callbacks get a new identity on every render.
			useFeatureSettings('reading', reading({ pendingCount, status: { state: 'synced', label },
				onRefresh: async () => { refreshes.push(label); },
				onExport: pendingCount ? () => {} : undefined }));
			const pending = useSettingsSelector(selectPending);
			selections.push(pending);
			return pending;
		}, undefined, children => createElement(SettingsContext.Provider, { value: store }, children));
		const render = (next: Partial<typeof props>) => { props = { ...props, ...next }; hook.rerender(); };
		return { store, listener, hook, render, refreshes, selections };
	}
	const selectPending = (snapshot: SettingsSnapshot) => snapshot.reading?.pendingCount ?? null;

	it('publishes stable callbacks that run the latest render, so an unchanged render publishes nothing', async () => {
		const { store, listener, render, refreshes } = mount();
		expect(listener).toHaveBeenCalledTimes(1);
		const first = store.getSnapshot().reading!;
		render({});
		render({});
		expect(listener).toHaveBeenCalledTimes(1);
		render({ label: 'Refreshing Reading' });
		expect(listener).toHaveBeenCalledTimes(2);
		const second = store.getSnapshot().reading!;
		expect(second.onRefresh).toBe(first.onRefresh);
		expect(second.canApplyUpdate).toBe(first.canApplyUpdate);
		await first.onRefresh();
		expect(refreshes).toEqual(['Refreshing Reading']);
	});

	it('publishes a callback appearing or disappearing', () => {
		const { store, listener, render } = mount();
		expect(store.getSnapshot().reading?.onExport).toBeUndefined();
		render({ pendingCount: 1 });
		const onExport = store.getSnapshot().reading?.onExport;
		expect(onExport).toBeTypeOf('function');
		render({ pendingCount: 0 });
		expect(store.getSnapshot().reading?.onExport).toBeUndefined();
		render({ pendingCount: 1 });
		expect(store.getSnapshot().reading?.onExport).toBe(onExport);
		expect(listener).toHaveBeenCalledTimes(4);
	});

	it('renders a subscriber again only when its selection changes', () => {
		const store = createSettingsStore();
		const renders = vi.fn();
		const hook = renderHook(() => {
			const status = useSettingsSelector(selectStatus, shallowEqual);
			renders();
			return status;
		}, undefined, children => createElement(SettingsContext.Provider, { value: store }, children));
		act(() => { store.setFeature('reading', reading()); });
		expect(renders).toHaveBeenCalledTimes(2);
		const status = hook.current;
		act(() => { store.setFeature('reading', reading({ pendingCount: 2 })); });
		act(() => { store.setOpen(true); });
		expect(renders).toHaveBeenCalledTimes(2);
		expect(hook.current).toBe(status);
		act(() => { store.setFeature('reading', reading({ status: { state: 'syncing', label: 'Refreshing Reading' } })); });
		expect(renders).toHaveBeenCalledTimes(3);
		expect(hook.current).toEqual({ state: 'syncing', label: 'Refreshing Reading' });
	});
	const selectStatus = (snapshot: SettingsSnapshot) => snapshot.reading?.status ?? null;
});
