import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR } from '@/cloudflare/worker/pwa/pwa-params';
import {
	lightThemeMediaForPreference,
	loadPwaThemePreference,
	PWA_LIGHT_SCHEME_MEDIA,
	PWA_LIGHT_THEME_STYLE_ID,
	PWA_THEME_COLOR_META_ID,
	preferredPwaColorScheme,
	resolvePwaColorScheme,
	savePwaThemePreference,
	type PwaColorScheme,
	type PwaThemePreference,
} from '../theme';

export { preferredPwaColorScheme } from '../theme';
export type { PwaColorScheme, PwaThemePreference } from '../theme';

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
	themeColor?.setAttribute('content', isLight ? PWA_LIGHT_CHROME_COLOR : PWA_CHROME_COLOR);
}

export function usePwaColorScheme(): {
	colorScheme: PwaColorScheme;
	themePreference: PwaThemePreference;
	setThemePreference: (preference: PwaThemePreference) => void;
} {
	const [themePreference, setThemePreferenceState] = useState<PwaThemePreference>(() => loadPwaThemePreference());
	const [systemScheme, setSystemScheme] = useState<PwaColorScheme>(() => preferredPwaColorScheme());
	const colorScheme = resolvePwaColorScheme(themePreference, systemScheme);

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

	return { colorScheme, themePreference, setThemePreference };
}
