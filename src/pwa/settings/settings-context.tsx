import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createSettingsStore, type SettingsSnapshot } from './settings-store';

export const SettingsContext = createContext<ReturnType<typeof createSettingsStore> | null>(null);

export function useSettingsStore() {
	const store = useContext(SettingsContext);
	if (!store) throw new Error('Settings must be mounted inside the feature shell');
	return store;
}

export function useSettingsOpen() {
	const store = useSettingsStore();
	return [useSyncExternalStore(store.subscribe, store.getOpen), store.setOpen] as const;
}

/** Renders again only when the selection changes. An equal selection, by `isEqual`,
 * keeps its previous identity. A new `select` function selects again. */
export function useSettingsSelector<T>(select: (snapshot: SettingsSnapshot) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
	const store = useSettingsStore();
	const getSelection = useMemo(() => {
		let cached: { snapshot: SettingsSnapshot; value: T } | undefined;
		return () => {
			const snapshot = store.getSnapshot();
			if (cached?.snapshot === snapshot) return cached.value;
			const value = select(snapshot);
			cached = { snapshot, value: cached && isEqual(cached.value, value) ? cached.value : value };
			return cached.value;
		};
	}, [store, select, isEqual]);
	return useSyncExternalStore(store.subscribe, getSelection);
}

type Callback = (...args: never[]) => unknown;

export function useFeatureSettings<K extends 'reading' | 'reminders'>(feature: K, value: NonNullable<SettingsSnapshot[K]>) {
	const store = useSettingsStore();
	// Each callback is published as one stable function that calls the latest
	// committed one, so the store can skip a model whose values are unchanged.
	const [callbacks] = useState(() => new Map<string, { latest: Callback; call: Callback }>());
	// Publish after each feature commit. Status, settings and update UI select from
	// the models; runtimes observe only the open boolean, avoiding a loop.
	useLayoutEffect(() => {
		const published: Record<string, unknown> = { ...value };
		for (const [key, field] of Object.entries(value)) {
			if (typeof field !== 'function') continue;
			let entry = callbacks.get(key);
			if (!entry) {
				const created = { latest: field as Callback, call: ((...args: never[]) => created.latest(...args)) as Callback };
				callbacks.set(key, entry = created);
			}
			entry.latest = field as Callback;
			published[key] = entry.call;
		}
		store.setFeature(feature, published as unknown as SettingsSnapshot[K]);
	});
	useLayoutEffect(() => () => store.setFeature(feature, null), [feature, store]);
}
