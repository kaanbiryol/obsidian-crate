import { useCallback, useReducer, useRef, useSyncExternalStore } from 'react';
import { PluginContext } from '@/ui/plugin/plugin-context';
import { subscribeReminderBackend, type ReminderBackend } from '@/reminders/runtime';

/**
 * Selects from the plugin's reminder backend, and selects again after an index
 * change, after a folder change replaces the backend, after `refresh` (for user
 * actions) and when `time` changes: pass the reminder clock for queries that read
 * the current time. Keep `select` stable; a new function selects again.
 */
export function useReminderRepository<T>(select: (backend: ReminderBackend | undefined) => T, time?: unknown): [T, () => void] {
	const plugin = PluginContext.use();
	const [refreshes, refresh] = useReducer((count: number) => count + 1, 0);
	// Follow each index that a folder change publishes in place of the current one.
	const subscribe = useCallback((listener: () => void) => {
		let unsubscribeIndex = plugin.reminders?.index.onIndexChange(listener);
		const unsubscribeBackend = subscribeReminderBackend(plugin, () => {
			unsubscribeIndex?.();
			unsubscribeIndex = plugin.reminders?.index.onIndexChange(listener);
			listener();
		});
		return () => { unsubscribeIndex?.(); unsubscribeBackend(); };
	}, [plugin]);
	const cache = useRef<{ inputs: unknown[]; value: T } | null>(null);
	const getSelection = () => {
		const backend = plugin.reminders;
		const inputs = [backend, backend?.index.getVersion(), select, refreshes, time];
		const cached = cache.current;
		if (cached && inputs.every((input, position) => Object.is(input, cached.inputs[position]))) return cached.value;
		cache.current = { inputs, value: select(backend) };
		return cache.current.value;
	};
	return [useSyncExternalStore(subscribe, getSelection), refresh];
}
