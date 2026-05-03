import { spawn } from 'node:child_process';
import net from 'node:net';

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

function waitForPreview(child, port) {
	return new Promise((resolve, reject) => {
		let output = '';
		const timeout = setTimeout(() => {
			reject(new Error(`Timed out waiting for PWA preview on port ${port}\n${output}`));
		}, 20_000);

		const finish = (error) => {
			clearTimeout(timeout);
			reject(error);
		};

		child.stdout.on('data', (chunk) => {
			output += chunk.toString();
			if (output.includes(`PWA preview running at http://127.0.0.1:${port}`)) {
				clearTimeout(timeout);
				resolve();
			}
		});
		child.stderr.on('data', (chunk) => {
			output += chunk.toString();
		});
		child.once('error', finish);
		child.once('exit', (code) => {
			finish(new Error(`PWA preview exited before readiness with code ${code}\n${output}`));
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
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['scripts/pwa-preview.mjs'], {
	cwd: process.cwd(),
	env: { ...process.env, PORT: String(port) },
	stdio: ['ignore', 'pipe', 'pipe'],
});

try {
	await waitForPreview(child, port);

	const pageResponse = await fetchOk(`${origin}/notifications?token=preview-install-token&folder=Reminders&upcomingDays=7`);
	const pageHtml = await pageResponse.text();
	if (!pageHtml.includes('<div id="app"></div>')) throw new Error('PWA page is missing the app root');
	if (!pageHtml.includes('/notifications/app.js?v=')) throw new Error('PWA page is missing the versioned app script');

	const manifestResponse = await fetchOk(`${origin}/notifications/manifest.json?token=preview-install-token&folder=Reminders&upcomingDays=7`);
	const manifest = await manifestResponse.json();
	if (manifest.start_url !== '/notifications?token=preview-install-token&folder=Reminders&upcomingDays=7') {
		throw new Error(`Unexpected manifest start_url: ${manifest.start_url}`);
	}

	const appResponse = await fetchOk(`${origin}/notifications/app.js?v=smoke`);
	const appJs = await appResponse.text();
	if (appJs.length < 100_000) throw new Error(`PWA app bundle is unexpectedly small: ${appJs.length} bytes`);

	const serviceWorkerResponse = await fetchOk(`${origin}/notifications/sw.js`);
	const serviceWorkerJs = await serviceWorkerResponse.text();
	if (!serviceWorkerJs.includes('crate-reminders-shell-')) throw new Error('Service worker shell cache name is missing');

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
	child.kill('SIGTERM');
}
