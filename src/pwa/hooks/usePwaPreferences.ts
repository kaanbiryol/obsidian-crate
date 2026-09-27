import { useCallback, useEffect, useState } from 'react';
import { loadPwaPreferences, savePwaPreferences, PWA_PREFERENCES_KEY, type PwaPreferences } from '../preferences';

const CHANGED = 'crate-preferences-changed';

export function usePwaPreferences() {
	const [preferences, setPreferences] = useState(loadPwaPreferences);
	useEffect(() => {
		const changed = () => setPreferences(loadPwaPreferences());
		const storage = (event: StorageEvent) => { if (event.key === PWA_PREFERENCES_KEY || event.key === null) changed(); };
		window.addEventListener(CHANGED, changed);
		window.addEventListener('storage', storage);
		return () => { window.removeEventListener(CHANGED, changed); window.removeEventListener('storage', storage); };
	}, []);
	const updatePreferences = useCallback((patch: Partial<PwaPreferences>) => {
		const next = { ...loadPwaPreferences(), ...patch };
		savePwaPreferences(next);
		setPreferences(next);
		window.dispatchEvent(new Event(CHANGED));
	}, []);
	return { preferences, updatePreferences };
}
