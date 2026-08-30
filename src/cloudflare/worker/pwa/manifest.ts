import { PWA_ASSET_VERSION } from '../pwa-version';
import { PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR, pwaStartSearchFromUrl } from './pwa-params';

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
		background_color: PWA_LIGHT_CHROME_COLOR,
		theme_color: PWA_LIGHT_CHROME_COLOR,
		color_scheme_dark: {
			background_color: PWA_CHROME_COLOR,
			theme_color: PWA_CHROME_COLOR,
		},
		categories: ['productivity', 'utilities'],
		launch_handler: {
			client_mode: 'navigate-existing',
		},
		shortcuts: [
			{
				name: 'Inbox',
				short_name: 'Inbox',
				url: '/notifications',
				icons: [{ src: `/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}`, sizes: '192x192', type: 'image/png' }],
			},
			{
				name: 'Today',
				short_name: 'Today',
				url: '/notifications?tab=today',
				icons: [{ src: `/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}`, sizes: '192x192', type: 'image/png' }],
			},
			{
				name: 'Upcoming',
				short_name: 'Upcoming',
				url: '/notifications?tab=upcoming',
				icons: [{ src: `/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}`, sizes: '192x192', type: 'image/png' }],
			},
		],
		icons: [
			{
				src: `/notifications/apple-touch-icon-180.png?v=${PWA_ASSET_VERSION}`,
				sizes: '180x180',
				type: 'image/png',
				purpose: 'any',
			},
			{
				src: `/notifications/crate-icon-192.png?v=${PWA_ASSET_VERSION}`,
				sizes: '192x192',
				type: 'image/png',
				purpose: 'any',
			},
			{
				src: `/notifications/crate-icon-512.png?v=${PWA_ASSET_VERSION}`,
				sizes: '512x512',
				type: 'image/png',
				purpose: 'any maskable',
			},
		],
	});
}
