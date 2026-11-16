// Stable address setup: Tailscale Funnel or a named Cloudflare Tunnel. Each step locks
// storage before provisioning and returns the saved remote settings that start serves.
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { packaged, runtimeRoot } from '../assets.mjs';
import { runProcess } from '../local-server-process.mjs';
import { openLocalRuntime } from '../local-server-runtime.mjs';
import { currentTailscaleHostname } from '../local-server-tailscale.mjs';
import { ensureCloudflared, normalizeTunnelHostname, saveTailscaleSettings, setupRemoteAccess } from '../local-server-tunnel.mjs';

/** @typedef {import('../local-server-options.mjs').CommandContext} CommandContext */
/** @typedef {import('../local-server-lifecycle.mjs').CommandResources} CommandResources */
/** @typedef {import('../local-server-tunnel.mjs').RemoteSettings} RemoteSettings */

/** A source checkout builds the Worker; an installed package ships it.
 * @param {AbortSignal} signal */
export async function buildIfSource(signal) {
	if (!packaged) await runProcess(process.execPath, [join(runtimeRoot, 'scripts/build-worker.mjs')], { signal });
}

/** Saves this computer's Tailscale Funnel address.
 * @param {CommandContext} context
 * @param {RemoteSettings | null} remote The directory's saved settings.
 * @param {number} port
 * @param {CommandResources} resources
 * @returns {Promise<RemoteSettings>} */
export async function setupTailscale({ dataDir, signal }, remote, port, resources) {
	console.log('Setting up Tailscale Funnel. Files stay on this computer; public HTTPS traffic passes through Tailscale.');
	await buildIfSource(signal);
	// Lock and validate storage before exposing anything.
	const runtime = resources.runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
	const hostname = await currentTailscaleHostname(signal);
	if (remote && remote.hostname !== hostname) throw new Error(`This directory was set up for https://${remote.hostname}. Rename this computer back in Tailscale to keep connected devices and PWAs.`);
	const saved = await saveTailscaleSettings(dataDir, hostname, port);
	await runtime.close();
	resources.runtime = null;
	return saved;
}

/** Provisions a named Cloudflare Tunnel and its DNS route, asking for the hostname when
 * none is saved or given.
 * @param {CommandContext} context
 * @param {RemoteSettings | null} remote The directory's saved settings.
 * @param {number} port
 * @param {CommandResources} resources
 * @returns {Promise<RemoteSettings>} */
export async function setupNamedTunnel({ dataDir, values, signal }, remote, port, resources) {
	let hostname = values.hostname ?? remote?.hostname;
	if (!hostname) {
		if (!process.stdin.isTTY) throw new Error('Provide --hostname crate.example.com when setup runs without an interactive terminal.');
		const prompt = createInterface({ input: process.stdin, output: process.stdout });
		try { hostname = await prompt.question('Public hostname on your Cloudflare domain (e.g. crate.example.com): ', { signal }); }
		finally { prompt.close(); }
	}
	hostname = normalizeTunnelHostname(hostname);
	if (remote && remote.hostname !== hostname) throw new Error('This directory already has a saved hostname. Reuse it to preserve installed PWA connections.');
	console.log(`Setting up https://${hostname}. Files stay on this computer; public HTTPS traffic passes through Cloudflare.`);
	await buildIfSource(signal);
	// Lock and validate storage before installing or provisioning anything.
	const runtime = resources.runtime = await openLocalRuntime({ dataDir, administrative: true, handleSignals: false });
	signal.throwIfAborted();
	await ensureCloudflared({ signal });
	const saved = await setupRemoteAccess({ dataDir, hostname, port, signal });
	await runtime.close();
	resources.runtime = null;
	return saved;
}
