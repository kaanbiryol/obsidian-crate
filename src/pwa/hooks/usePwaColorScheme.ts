import { createContext, useContext } from 'react';
import type { PwaColorScheme, PwaThemePreference } from '../theme';

interface PwaThemeState {
	colorScheme: PwaColorScheme;
	themePreference: PwaThemePreference;
	setThemePreference: (preference: PwaThemePreference) => void;
}

export const PwaThemeContext = createContext<PwaThemeState | null>(null);

export function usePwaColorScheme(): PwaThemeState {
	const theme = useContext(PwaThemeContext);
	if (!theme) throw new Error('PWA theme must be read inside the app theme provider.');
	return theme;
}
