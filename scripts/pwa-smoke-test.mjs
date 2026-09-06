import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
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
	const { startupAssets, assets: clientAssets } = JSON.parse(await readFile('.generated/cloudflare/pwa-client.json', 'utf-8'));
	for (const name of Object.keys(clientAssets).filter(name => name !== 'app.js')) {
		const preload = `<link rel="modulepreload" href="/notifications/assets/${name}">`;
		if (pageHtml.includes(preload) !== startupAssets.includes(name)) {
			throw new Error(`Incorrect startup preload for ${name}`);
		}
	}
	if (!pageHtml.includes('<div id="app"><div class="pwa-launch-splash"')) throw new Error('PWA page is missing the launch splash');
	if (!pageHtml.includes('/notifications/app.js?v=')) throw new Error('PWA page is missing the versioned app script');
	if (!pageHtml.includes('/notifications/theme-bootstrap.js?v=')) throw new Error('PWA page is missing the theme bootstrap script');
	if (pageHtml.includes('<script>')) throw new Error('PWA page contains an inline script');
	const homeScreenHtml = await (await fetchOk(`${origin}/notifications?folder=Reminders`)).text();
	const sessionScriptIndex = homeScreenHtml.indexOf('<script src="/notifications/preview-session.js"></script>');
	if (sessionScriptIndex < 0 || sessionScriptIndex > homeScreenHtml.indexOf('</head>')) {
		throw new Error('Tokenless Home Screen preview is missing its early fixture session bootstrap');
	}
	const sessionScript = await (await fetchOk(`${origin}/notifications/preview-session.js`)).text();
	const previewStorage = new Map();
	new Script(sessionScript).runInNewContext({ localStorage: { setItem: (key, value) => previewStorage.set(key, value) } });
	if (previewStorage.get('crate-reminders-auth-token') !== 'preview-auth-token') {
		throw new Error('Home Screen preview did not initialize its fixture session');
	}
	if (pageHtml.includes('apple-touch-startup-image')) throw new Error('PWA page still includes device-specific startup images');

	const manifestResponse = await fetchOk(`${origin}/notifications/manifest.json?token=preview-install-token&folder=Reminders&upcomingDays=7`);
	const manifest = await manifestResponse.json();
	if (manifest.start_url !== '/notifications?token=preview-install-token&folder=Reminders&upcomingDays=7') {
		throw new Error(`Unexpected manifest start_url: ${manifest.start_url}`);
	}
	if (manifest.background_color !== '#f7f7f8' || manifest.color_scheme_dark?.background_color !== '#0b0b0d') {
		throw new Error('PWA manifest is missing light and dark launch colors');
	}

	const appResponse = await fetchOk(`${origin}/notifications/app.js?v=smoke`);
	const appJs = await appResponse.text();
	if (appJs.length < 40_000 || appJs.length > 110_000) throw new Error(`PWA app entry is outside its expected range: ${appJs.length} bytes`);
	for (const [fileName, source] of Object.entries(assets.PWA_CLIENT_ASSETS)) {
		if (fileName === 'app.js') continue;
		const chunkResponse = await fetchOk(`${origin}/notifications/assets/${fileName}`);
		if ((await chunkResponse.text()) !== source) throw new Error(`PWA chunk response did not match ${fileName}`);
	}

	const themeResponse = await fetchOk(`${origin}/notifications/theme-bootstrap.js?v=smoke`);
	new Script(await themeResponse.text());

	const serviceWorkerResponse = await fetchOk(`${origin}/notifications/sw.js`);
	if (serviceWorkerResponse.headers.get('service-worker-allowed') !== '/notifications') {
		throw new Error('Service worker scope header is missing');
	}
	const serviceWorkerJs = await serviceWorkerResponse.text();
	if (!serviceWorkerJs.includes('crate-reminders-shell-')) throw new Error('Service worker shell cache name is missing');
	new Script(serviceWorkerJs);

	const handoffResponse = await fetchOk(`${origin}/notifications/open-obsidian?project=Work`);
	const handoffHtml = await handoffResponse.text();
	if (!handoffHtml.includes('/notifications/open-obsidian.js?v=')) throw new Error('Obsidian handoff page is missing its external script');
	if (handoffHtml.includes('<script>')) throw new Error('Obsidian handoff page contains an inline script');
	const handoffScriptResponse = await fetchOk(`${origin}/notifications/open-obsidian.js?v=smoke`);
	new Script(await handoffScriptResponse.text());

	for (const [path, minimumBytes] of [
		['/notifications/crate-mark-256.png?v=smoke', 5_000],
		['/notifications/crate-icon-192.png?v=smoke', 5_000],
		['/notifications/crate-icon-512.png?v=smoke', 20_000],
		['/notifications/apple-touch-icon-180.png?v=smoke', 5_000],
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
