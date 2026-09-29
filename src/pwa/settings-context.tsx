import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react';
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

export function useFeatureSettings<K extends 'reading' | 'reminders'>(feature: K, value: SettingsSnapshot[K]) {
	const store = useSettingsStore();
	// Publish after each feature commit. Status, settings and update UI subscribe
	// to the models; runtimes observe only the open boolean, avoiding a loop.
	useLayoutEffect(() => { store.setFeature(feature, value); });
	useLayoutEffect(() => () => store.setFeature(feature, null), [feature, store]);
}
