import { act, createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { renderHook } from '@/test/react-hooks';
import type CratePlugin from '@/plugin/CratePlugin';
import type { ReminderBackend } from '@/reminders/runtime';

const backendListeners = new Set<() => void>();
vi.mock('@/reminders/runtime', () => ({
	subscribeReminderBackend: (_plugin: unknown, listener: () => void) => {
		backendListeners.add(listener);
		return () => { backendListeners.delete(listener); };
	},
}));

import { PluginContext } from '@/ui/plugin/plugin-context';
import { useReminderRepository } from './useReminderRepository';

function fakeBackend(name: string) {
	const listeners = new Set<() => void>();
	let version = 0;
	const backend = { name, index: {
		getVersion: () => version,
		onIndexChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	} } as unknown as ReminderBackend & { name: string };
	const change = () => act(() => { version++; listeners.forEach(listener => listener()); });
	return { backend, change, listeners };
}

function mount(initial: ReminderBackend) {
	const plugin = { reminders: initial } as unknown as CratePlugin;
	const select = vi.fn((backend: ReminderBackend | undefined) => ({ name: (backend as { name?: string } | undefined)?.name }));
	let time: unknown = null;
	const hook = renderHook(() => useReminderRepository(select, time), undefined,
		children => createElement(PluginContext.Provider, { value: plugin }, children));
	return { plugin, select, hook, setTime: (next: unknown) => { time = next; hook.rerender(); } };
}

it('selects again after an index change, a refresh or a new time, not on an unrelated render', () => {
	const first = fakeBackend('first');
	const { select, hook, setTime } = mount(first.backend);
	expect(select).toHaveBeenCalledTimes(1);
	const selection = hook.current[0];
	hook.rerender();
	expect(select).toHaveBeenCalledTimes(1);
	expect(hook.current[0]).toBe(selection);

	first.change();
	expect(select).toHaveBeenCalledTimes(2);
	act(() => hook.current[1]());
	expect(select).toHaveBeenCalledTimes(3);
	setTime({ now: new Date() });
	expect(select).toHaveBeenCalledTimes(4);
});

it('follows the index that a folder change publishes and leaves the replaced one', () => {
	const first = fakeBackend('first');
	const second = fakeBackend('second');
	const { plugin, select, hook } = mount(first.backend);
	expect(hook.current[0]).toEqual({ name: 'first' });

	act(() => { plugin.reminders = second.backend; backendListeners.forEach(listener => listener()); });
	expect(hook.current[0]).toEqual({ name: 'second' });
	expect(first.listeners.size).toBe(0);
	expect(second.listeners.size).toBe(1);
	const calls = select.mock.calls.length;
	first.change();
	expect(select).toHaveBeenCalledTimes(calls);
	second.change();
	expect(select).toHaveBeenCalledTimes(calls + 1);

	hook.unmount();
	expect(second.listeners.size).toBe(0);
	expect(backendListeners.size).toBe(0);
});
