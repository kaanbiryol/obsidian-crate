export type PwaColorScheme = 'light' | 'dark';
export type PwaThemePreference = 'system' | PwaColorScheme;

export const PWA_THEME_PREFERENCE_KEY = 'crate-reminders-theme';
export const PWA_LIGHT_THEME_STYLE_ID = 'pwa-light-theme';
export const PWA_THEME_COLOR_META_ID = 'pwa-theme-color';
export const PWA_LIGHT_SCHEME_MEDIA = '(prefers-color-scheme: light)';

export function parsePwaThemePreference(value: unknown): PwaThemePreference {
	return value === 'light' || value === 'dark' ? value : 'system';
}

export function loadPwaThemePreference(
	storage: Pick<Storage, 'getItem'> = localStorage,
): PwaThemePreference {
	try {
		return parsePwaThemePreference(storage.getItem(PWA_THEME_PREFERENCE_KEY));
	} catch {
		return 'system';
	}
}

export function savePwaThemePreference(
	preference: PwaThemePreference,
	storage: Pick<Storage, 'setItem'> = localStorage,
): void {
	try {
		storage.setItem(PWA_THEME_PREFERENCE_KEY, preference);
	} catch {
		// Theme persistence is best-effort when storage is unavailable.
	}
}

export function preferredPwaColorScheme(
	preference: Pick<MediaQueryList, 'matches'> = window.matchMedia(PWA_LIGHT_SCHEME_MEDIA),
): PwaColorScheme {
	return preference.matches ? 'light' : 'dark';
}

export function resolvePwaColorScheme(
	preference: PwaThemePreference,
	systemScheme: PwaColorScheme,
): PwaColorScheme {
	return preference === 'system' ? systemScheme : preference;
}

export function lightThemeMediaForPreference(preference: PwaThemePreference): string {
	if (preference === 'light') return 'all';
	if (preference === 'dark') return 'not all';
	return PWA_LIGHT_SCHEME_MEDIA;
}
