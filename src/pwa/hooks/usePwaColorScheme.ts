import { useEffect, useState } from 'react';

export type PwaColorScheme = 'light' | 'dark';

export function preferredPwaColorScheme(
	preference: Pick<MediaQueryList, 'matches'> = window.matchMedia('(prefers-color-scheme: light)'),
): PwaColorScheme {
	return preference.matches ? 'light' : 'dark';
}

export function usePwaColorScheme(): PwaColorScheme {
	const [colorScheme, setColorScheme] = useState<PwaColorScheme>(() => preferredPwaColorScheme());

	useEffect(() => {
		const preference = window.matchMedia('(prefers-color-scheme: light)');
		const updateColorScheme = () => setColorScheme(preferredPwaColorScheme(preference));

		updateColorScheme();
		if (typeof preference.addEventListener === 'function') {
			preference.addEventListener('change', updateColorScheme);
			return () => preference.removeEventListener('change', updateColorScheme);
		}

		preference.addListener(updateColorScheme);
		return () => preference.removeListener(updateColorScheme);
	}, []);

	return colorScheme;
}
