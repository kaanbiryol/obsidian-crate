import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { PwaThemeContext } from '../hooks/usePwaColorScheme';
import { PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR } from '@/cloudflare/worker/pwa/pwa-params';
import {
	lightThemeMediaForPreference,
	loadPwaThemePreference,
	PWA_LIGHT_SCHEME_MEDIA,
	PWA_LIGHT_THEME_STYLE_ID,
	PWA_THEME_COLOR_META_ID,
	PWA_THEME_PREFERENCE_KEY,
	preferredPwaColorScheme,
	resolvePwaColorScheme,
	savePwaThemePreference,
	type PwaColorScheme,
	type PwaThemePreference,
} from '../theme';

function applyPwaColorScheme(preference: PwaThemePreference, colorScheme: PwaColorScheme): void {
	const isLight = colorScheme === 'light';
	const root = document.documentElement;
	root.dataset.pwaColorScheme = colorScheme;
	root.style.setProperty('--pwa-launch-bg', isLight ? PWA_LIGHT_CHROME_COLOR : PWA_CHROME_COLOR);
	root.style.background = isLight ? PWA_LIGHT_CHROME_COLOR : PWA_CHROME_COLOR;
	root.style.colorScheme = colorScheme;

	const lightTheme = document.getElementById(PWA_LIGHT_THEME_STYLE_ID) as HTMLStyleElement | null;
	if (lightTheme) lightTheme.media = lightThemeMediaForPreference(preference);

	const themeColor = document.getElementById(PWA_THEME_COLOR_META_ID);
	themeColor?.setAttribute('media', 'all');
	themeColor?.setAttribute('content', isLight ? PWA_LIGHT_CHROME_COLOR : PWA_CHROME_COLOR);
}

export function PwaThemeProvider({ children }: { children: ReactNode }) {
	const [themePreference, setThemePreferenceState] = useState<PwaThemePreference>(() => loadPwaThemePreference());
	const [systemScheme, setSystemScheme] = useState<PwaColorScheme>(() => preferredPwaColorScheme());
	const colorScheme = resolvePwaColorScheme(themePreference, systemScheme);
	useEffect(() => {
		const changed = (event: StorageEvent) => {
			if (event.key === null || event.key === PWA_THEME_PREFERENCE_KEY) setThemePreferenceState(loadPwaThemePreference());
		};
		window.addEventListener('storage', changed);
		return () => window.removeEventListener('storage', changed);
	}, []);

	useEffect(() => {
		const preference = window.matchMedia(PWA_LIGHT_SCHEME_MEDIA);
		const updateColorScheme = () => setSystemScheme(preferredPwaColorScheme(preference));

		updateColorScheme();
		if (typeof preference.addEventListener === 'function') {
			preference.addEventListener('change', updateColorScheme);
			return () => preference.removeEventListener('change', updateColorScheme);
		}

		preference.addListener(updateColorScheme);
		return () => preference.removeListener(updateColorScheme);
	}, []);

	useLayoutEffect(() => {
		applyPwaColorScheme(themePreference, colorScheme);
	}, [colorScheme, themePreference]);

	const setThemePreference = useCallback((preference: PwaThemePreference) => {
		savePwaThemePreference(preference);
		setThemePreferenceState(preference);
	}, []);

	const value = useMemo(() => ({ colorScheme, themePreference, setThemePreference }), [colorScheme, themePreference, setThemePreference]);
	return <PwaThemeContext.Provider value={value}>{children}</PwaThemeContext.Provider>;
}
