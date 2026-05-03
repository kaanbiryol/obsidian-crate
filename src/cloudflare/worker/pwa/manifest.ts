import { PWA_ASSET_VERSION } from '../pwa-version.gen';
import { PWA_CHROME_COLOR, pwaStartSearchFromUrl } from './pwa-params';

export function createManifestJson(requestUrl?: string): string {
	return JSON.stringify({
		id: '/notifications',
		name: 'Crate Reminders',
		short_name: 'Crate',
		description: 'Manage Crate reminders without opening Obsidian.',
		start_url: `/notifications${pwaStartSearchFromUrl(requestUrl)}`,
		scope: '/notifications',
		display: 'standalone',
		display_override: ['standalone', 'minimal-ui'],
		orientation: 'portrait',
		background_color: PWA_CHROME_COLOR,
		theme_color: PWA_CHROME_COLOR,
		categories: ['productivity', 'utilities'],
		launch_handler: {
			client_mode: 'navigate-existing',
		},
		shortcuts: [
			{
				name: 'Inbox',
				short_name: 'Inbox',
				url: '/notifications',
				icons: [{ src: `/notifications/icon.svg?v=${PWA_ASSET_VERSION}`, sizes: 'any', type: 'image/svg+xml' }],
			},
			{
				name: 'Today',
				short_name: 'Today',
				url: '/notifications?tab=today',
				icons: [{ src: `/notifications/icon.svg?v=${PWA_ASSET_VERSION}`, sizes: 'any', type: 'image/svg+xml' }],
			},
			{
				name: 'Upcoming',
				short_name: 'Upcoming',
				url: '/notifications?tab=upcoming',
				icons: [{ src: `/notifications/icon.svg?v=${PWA_ASSET_VERSION}`, sizes: 'any', type: 'image/svg+xml' }],
			},
		],
		icons: [
			{
				src: `/notifications/icon.svg?v=${PWA_ASSET_VERSION}`,
				sizes: 'any',
				type: 'image/svg+xml',
				purpose: 'any maskable',
			},
		],
	});
}

export const MANIFEST_JSON = createManifestJson();
