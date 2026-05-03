import { PWA_ASSET_VERSION } from '../pwa-version.gen';

export const PWA_CHROME_COLOR = '#080808';
const PWA_START_PARAM_KEYS = ['token', 'folder', 'upcomingDays', 'allDayTime', 'project', 'tab'] as const;

export function pwaStartSearchFromUrl(requestUrl?: string): string {
	if (!requestUrl) return '';

	const source = new URL(requestUrl).searchParams;
	const params = new URLSearchParams();
	for (const key of PWA_START_PARAM_KEYS) {
		const value = source.get(key)?.trim();
		if (value) params.set(key, value);
	}

	const query = params.toString();
	return query ? `?${query}` : '';
}

export function manifestHrefForUrl(requestUrl?: string): string {
	const startSearch = pwaStartSearchFromUrl(requestUrl);
	const versionSeparator = startSearch ? '&' : '?';
	return `/notifications/manifest.json${startSearch}${versionSeparator}v=${PWA_ASSET_VERSION}`;
}
