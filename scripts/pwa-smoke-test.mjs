import net from 'node:net';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

async function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Unable to allocate a preview port')));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

async function fetchOk(url, init) {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`${init?.method ?? 'GET'} ${url} returned ${response.status}: ${await response.text()}`);
	}
	return response;
}

const port = await getFreePort();
const assets = await buildPwaPreviewAssets();
const { server, origin } = await listenPwaPreviewServer({ port, assets });

try {
	const pageResponse = await fetchOk(`${origin}/notifications?token=preview-install-token&folder=Reminders&upcomingDays=7`);
	const pageHtml = await pageResponse.text();
	if (!pageHtml.includes('<div id="app"><div class="pwa-bootstrap-shell"')) throw new Error('PWA page is missing the themed loading shell');
	if (!pageHtml.includes('/notifications/app.js?v=')) throw new Error('PWA page is missing the versioned app script');
	if (!pageHtml.includes('/notifications/apple-startup-1206x2622.png?v=')) throw new Error('PWA page is missing the iPhone startup image');

	const manifestResponse = await fetchOk(`${origin}/notifications/manifest.json?token=preview-install-token&folder=Reminders&upcomingDays=7`);
	const manifest = await manifestResponse.json();
	if (manifest.start_url !== '/notifications?token=preview-install-token&folder=Reminders&upcomingDays=7') {
		throw new Error(`Unexpected manifest start_url: ${manifest.start_url}`);
	}

	const appResponse = await fetchOk(`${origin}/notifications/app.js?v=smoke`);
	const appJs = await appResponse.text();
	if (appJs.length < 100_000) throw new Error(`PWA app bundle is unexpectedly small: ${appJs.length} bytes`);

	const serviceWorkerResponse = await fetchOk(`${origin}/notifications/sw.js`);
	if (serviceWorkerResponse.headers.get('service-worker-allowed') !== '/notifications') {
		throw new Error('Service worker scope header is missing');
	}
	const serviceWorkerJs = await serviceWorkerResponse.text();
	if (!serviceWorkerJs.includes('crate-reminders-shell-')) throw new Error('Service worker shell cache name is missing');

	for (const [path, minimumBytes] of [
		['/notifications/crate-mark-256.png?v=smoke', 5_000],
		['/notifications/crate-icon-192.png?v=smoke', 5_000],
		['/notifications/crate-icon-512.png?v=smoke', 20_000],
		['/notifications/apple-touch-icon-180.png?v=smoke', 5_000],
		['/notifications/apple-startup-1179x2556.png?v=smoke', 1_000],
		['/notifications/apple-startup-1206x2622.png?v=smoke', 1_000],
		['/notifications/apple-startup-1290x2796.png?v=smoke', 1_000],
	]) {
		const imageResponse = await fetchOk(`${origin}${path}`);
		if (imageResponse.headers.get('Content-Type') !== 'image/png') {
			throw new Error(`${path} is not served as image/png`);
		}
		if ((await imageResponse.arrayBuffer()).byteLength < minimumBytes) {
			throw new Error(`${path} is unexpectedly small`);
		}
	}

	const exchangeResponse = await fetchOk(`${origin}/notifications/reminders-exchange`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token: 'preview-install-token', deviceName: 'Smoke test' }),
	});
	const exchange = await exchangeResponse.json();
	if (exchange.authToken !== 'preview-auth-token') throw new Error('Preview token exchange did not return the expected auth token');

	const remindersResponse = await fetchOk(`${origin}/reminders/list?folderPath=Reminders`, {
		headers: { Authorization: `Bearer ${exchange.authToken}` },
	});
	const reminders = await remindersResponse.json();
	if (!Array.isArray(reminders.reminders) || reminders.reminders.length === 0) {
		throw new Error('Preview reminders list is empty');
	}
	if (!Array.isArray(reminders.projects) || !reminders.projects.includes('Inbox')) {
		throw new Error('Preview projects list is missing Inbox');
	}

	console.log(`PWA preview smoke test passed on ${origin}`);
} finally {
	await new Promise((resolve) => server.close(resolve));
}
