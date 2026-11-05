import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startProcess } from './local-server-process.mjs';
import { normalizeTunnelHostname } from './local-server-tunnel.mjs';

const execFileAsync = promisify(execFile);
// The Mac app ships its CLI inside the bundle and does not always add it to PATH.
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export async function findTailscale({ platform = process.platform, run = execFileAsync } = {}) {
	for (const command of ['tailscale', ...(platform === 'darwin' ? [MAC_APP_CLI] : [])]) {
		try { await run(command, ['version']); return command; }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
	throw new Error('Install Tailscale and sign in, then rerun setup: https://tailscale.com/download');
}

function parseStatus(text) {
	try { return JSON.parse(text); }
	catch { throw new Error('Could not read Tailscale status. Update Tailscale, then retry.'); }
}

function hostnameFromStatus(status) {
	if (status?.BackendState !== 'Running') throw new Error('Tailscale is not connected. Open Tailscale or run tailscale up, sign in, then retry.');
	const name = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : '';
	if (!name.endsWith('.ts.net')) throw new Error('Turn on MagicDNS and HTTPS certificates for your tailnet, then retry: https://login.tailscale.com/admin/dns');
	return normalizeTunnelHostname(name);
}

/** This machine's stable public name, from the signed-in Tailscale client. */
export async function tailscaleHostname(command, { run = execFileAsync } = {}) {
	return hostnameFromStatus(parseStatus((await run(command, ['status', '--json'])).stdout));
}

/** In Docker, a Tailscale container next to Crate serves Funnel. Crate reads its
 * name over the LocalAPI socket the two containers share. */
export const tailscaleSocket = () => process.env.CRATE_TAILSCALE_SOCKET || null;

function localApiStatus(socketPath) {
	return new Promise((resolve, reject) => {
		const call = request({ socketPath, path: '/localapi/v0/status', headers: { Host: 'local-tailscaled.sock' }, timeout: 5000 }, response => {
			let body = '';
			response.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) call.destroy(new Error('Tailscale status is too large.')); });
			response.on('end', () => response.statusCode === 200 ? resolve(body) : reject(new Error(`Tailscale status failed (${response.statusCode}).`)));
		});
		call.on('error', reject);
		call.on('timeout', () => call.destroy(new Error('Tailscale status timed out.')));
		call.end();
	});
}

/** Waits while the Tailscale container starts or waits for sign-in, showing its login link once. */
export async function socketTailscaleHostname(socketPath, { signal, interval = 2000, log = console.log, status = localApiStatus } = {}) {
	let announced = '';
	for (;;) {
		signal?.throwIfAborted();
		let current = null;
		try { current = parseStatus(await status(socketPath)); }
		catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
		if (current?.BackendState === 'Running') return hostnameFromStatus(current);
		const message = current?.AuthURL ? `Sign in to Tailscale to finish setup: ${current.AuthURL}` : 'Waiting for the Tailscale container to start and sign in.';
		if (message !== announced) { log(message); announced = message; }
		await delay(interval, undefined, { signal });
	}
}

/** The saved name, read from the CLI or, in Docker, the shared socket. */
export async function currentTailscaleHostname(signal) {
	const socket = tailscaleSocket();
	return socket ? socketTailscaleHostname(socket, { signal }) : tailscaleHostname(await findTailscale());
}

/** Runs Funnel in the foreground, so stopping Crate also takes its public address offline.
 * The first run prints a Tailscale link to approve Funnel for this tailnet. */
export async function startTailscaleFunnel(settings, signal, { run = execFileAsync, platform = process.platform, start = startProcess, socket = tailscaleSocket() } = {}) {
	const command = socket ? null : await findTailscale({ platform, run });
	const hostname = socket ? await socketTailscaleHostname(socket, { signal }) : await tailscaleHostname(command, { run });
	if (hostname !== settings.hostname) {
		throw new Error(`This server was set up for https://${settings.hostname}, but Tailscale now names this computer ${hostname}. Rename the computer back in Tailscale; a new address requires reconnecting every device and PWA.`);
	}
	// The Tailscale container's serve configuration publishes Funnel; it outlives Crate restarts.
	if (socket) return { exited: new Promise(() => {}), async stop() {} };
	return start(command, ['funnel', '--https=443', `http://127.0.0.1:${settings.port}`], { signal });
}
