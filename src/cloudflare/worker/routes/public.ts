import { readingShareFallback } from '../../../pwa/shell/share-target';
import { readingSavePage, readingSaveScript } from '../reading/save-page';
import { developmentShortcutPage, developmentShortcutResponse } from '../reading/development-shortcut';
import { DEVELOPMENT_SHORTCUT_FILE_PATH, DEVELOPMENT_SHORTCUT_PATH } from '../../../reading/shortcut';
import {
	handleExchangeRemindersEnrollmentToken,
	handleVapidPublicKey,
} from '../notifications/enrollment-handlers';
import {
	handleAppleTouchIcon,
	handleCrateIcon192,
	handleCrateIcon512,
	handleCrateMark256,
	handleIcon,
	handleManifest,
	handleNotificationsPage,
	handleOpenObsidian,
	handleOpenObsidianScript,
	handlePairDevice,
	handlePairDeviceScript,
	handlePwaApp,
	handlePwaClientAsset,
	handlePwaThemeBootstrap,
	handlePwaVersion,
	handleServiceWorker,
} from '../pwa/asset-handlers';
import { handleServerInfo } from '../server-info';
import { exchangeDevicePairing } from '../auth/device-pairing';
import { DEVICE_PAIRING_PAGE, DEVICE_PAIRING_PATH } from '../../../protocol/device-pairing';
import type { Env } from '../types';

export async function handlePublicRoute(
	request: Request,
	env: Env,
	path: string,
	method: Request['method'],
): Promise<Response | null> {
	const db = env.DB;
 // Before a service worker controls the app, echo the form back for the page to store locally.
 if (path === '/notifications/share/reading' && method === 'POST') return readingShareFallback(request);
 if (path === '/notifications/save-reading' && method === 'GET') return readingSavePage();
 if (path === '/notifications/save-reading.js' && method === 'GET') return readingSaveScript({ serverFingerprint: env.CRATE_DEPLOYMENT_FINGERPRINT });
	if (path === DEVELOPMENT_SHORTCUT_PATH && method === 'GET') return developmentShortcutPage();
	if (path === DEVELOPMENT_SHORTCUT_FILE_PATH && method === 'GET') return developmentShortcutResponse();
	if (path === '/.well-known/crate' && method === 'GET') return handleServerInfo(env);
	if (path === '/' && method === 'GET') return handleServerInfo(env);
	if (path === '/notifications' && method === 'GET') return handleNotificationsPage(request);
	if (path === '/notifications/app.js' && method === 'GET') return handlePwaApp(request);
	if (path.startsWith('/notifications/assets/') && method === 'GET') {
		return handlePwaClientAsset(request, path.slice('/notifications/assets/'.length));
	}
	if (path === '/notifications/theme-bootstrap.js' && method === 'GET') return handlePwaThemeBootstrap(request);
	if (path === '/notifications/sw.js' && method === 'GET') return handleServiceWorker();
	if (path === '/notifications/manifest.json' && method === 'GET') return handleManifest(request);
	if (path === '/notifications/version.json' && method === 'GET') return handlePwaVersion();
	if (path === '/notifications/icon.svg' && method === 'GET') return handleIcon(request);
	if (path === '/notifications/crate-icon-192.png' && method === 'GET') return handleCrateIcon192(request);
	if (path === '/notifications/crate-icon-512.png' && method === 'GET') return handleCrateIcon512(request);
	if (path === '/notifications/crate-mark-256.png' && method === 'GET') return handleCrateMark256(request);
	if (path === '/notifications/apple-touch-icon-180.png' && method === 'GET') return handleAppleTouchIcon(request);
	if (path === '/notifications/open-obsidian' && method === 'GET') return handleOpenObsidian();
	if (path === '/notifications/open-obsidian.js' && method === 'GET') return handleOpenObsidianScript(request);
	if (path === DEVICE_PAIRING_PAGE && method === 'GET') return handlePairDevice();
	if (path === `${DEVICE_PAIRING_PAGE}.js` && method === 'GET') return handlePairDeviceScript(request);
	if (path === DEVICE_PAIRING_PATH && method === 'POST') return await exchangeDevicePairing(request, db);
	if (path === '/notifications/vapid-public-key' && method === 'GET') return await handleVapidPublicKey(db);
	if (path === '/notifications/reminders-exchange' && method === 'POST') {
		return await handleExchangeRemindersEnrollmentToken(request, db);
	}

	return null;
}
